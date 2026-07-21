import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import { MATCH_TEXT_NORMALIZATION_VERSION } from "../identity/normalization.ts";

/** Version of the bounded source-pair generation policy. */
export const CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION = "cross-source-candidate-v1";
export const DEFAULT_CROSS_SOURCE_CANDIDATE_WINDOW_MS = 30_000;
export const MAX_CROSS_SOURCE_CANDIDATE_WINDOW_MS = 120_000;
const TIME_BLOCK_MS = 60_000;

export interface CrossSourceCandidateGenerationOptions {
  readonly now?: () => number;
  readonly windowMs?: number;
}

export interface CrossSourceCandidateGenerationSummary {
  readonly inserted: number;
  readonly existing: number;
  readonly windowMs: number;
  readonly ruleVersion: typeof CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION;
}

interface CandidatePairRow extends SqliteRow {
  readonly spotify_source_record_id: number;
  readonly lastfm_source_record_id: number;
  readonly candidate_reason: "shared_track_identity" | "matching_normalized_artist_track";
}

/**
 * Uses source-specific indexed minute blocks before checking the exact configurable window.
 * Each side is restricted to the primary link of a current or unresolved canonical event, so
 * P2-04 exact duplicates do not multiply cross-source candidate pairs.
 */
export const CROSS_SOURCE_CANDIDATE_PAIRS_SQL = `
  WITH minute_block_offset(offset) AS (
    VALUES (0), (-1), (1), (-2), (2)
  )
  SELECT spotify.source_record_id AS spotify_source_record_id,
         lastfm.source_record_id AS lastfm_source_record_id,
         CASE
           WHEN spotify_resolution.track_id = lastfm_resolution.track_id
             THEN 'shared_track_identity'
           ELSE 'matching_normalized_artist_track'
         END AS candidate_reason
    FROM spotify_play_source AS spotify
    JOIN source_identity_resolution AS spotify_resolution
      ON spotify_resolution.source_record_id = spotify.source_record_id
    JOIN listening_event_source AS spotify_link
      ON spotify_link.source_record_id = spotify.source_record_id
     AND spotify_link.evidence_role = 'primary'
    JOIN listening_event AS spotify_event
      ON spotify_event.id = spotify_link.listening_event_id
     AND spotify_event.event_status IN ('current', 'unresolved')
    CROSS JOIN minute_block_offset AS block_offset
    JOIN lastfm_scrobble_source AS lastfm
      INDEXED BY lastfm_scrobble_source_time_block_idx
      ON (lastfm.scrobbled_at_epoch_ms / ${String(TIME_BLOCK_MS)}) =
           ((spotify.stopped_at_epoch_ms - spotify.ms_played) / ${String(TIME_BLOCK_MS)}) + block_offset.offset
    JOIN lastfm_scrobble_occurrence AS lastfm_occurrence
      ON lastfm_occurrence.lastfm_scrobble_source_record_id = lastfm.source_record_id
    JOIN source_identity_resolution AS lastfm_resolution
      ON lastfm_resolution.source_record_id = lastfm_occurrence.source_record_id
    JOIN listening_event_source AS lastfm_link
      ON lastfm_link.source_record_id = lastfm_occurrence.source_record_id
     AND lastfm_link.evidence_role = 'primary'
    JOIN listening_event AS lastfm_event
      ON lastfm_event.id = lastfm_link.listening_event_id
     AND lastfm_event.event_status IN ('current', 'unresolved')
   WHERE abs(block_offset.offset) <= @blockRadius
     AND abs(lastfm.scrobbled_at_epoch_ms - (spotify.stopped_at_epoch_ms - spotify.ms_played)) <= @windowMs
     AND (
       spotify_resolution.track_id = lastfm_resolution.track_id
       OR (
         EXISTS (
           SELECT 1
             FROM artist_alias AS spotify_artist_alias
             JOIN artist_alias AS lastfm_artist_alias
               ON lastfm_artist_alias.normalized_alias = spotify_artist_alias.normalized_alias
              AND lastfm_artist_alias.normalization_version = spotify_artist_alias.normalization_version
            WHERE spotify_artist_alias.artist_id = spotify_resolution.artist_id
              AND lastfm_artist_alias.artist_id = lastfm_resolution.artist_id
              AND spotify_artist_alias.normalization_version = @normalizationVersion
         )
         AND EXISTS (
           SELECT 1
             FROM track_alias AS spotify_track_alias
             JOIN track_alias AS lastfm_track_alias
               ON lastfm_track_alias.normalized_alias = spotify_track_alias.normalized_alias
              AND lastfm_track_alias.normalization_version = spotify_track_alias.normalization_version
            WHERE spotify_track_alias.track_id = spotify_resolution.track_id
              AND lastfm_track_alias.track_id = lastfm_resolution.track_id
              AND spotify_track_alias.normalization_version = @normalizationVersion
         )
       )
     )
   GROUP BY spotify.source_record_id, lastfm.source_record_id
`;

function validatedWindow(windowMs: number): number {
  if (
    !Number.isInteger(windowMs) ||
    windowMs < 0 ||
    windowMs > MAX_CROSS_SOURCE_CANDIDATE_WINDOW_MS
  ) {
    throw new RangeError(
      `Cross-source candidate window must be an integer from 0 to ${String(MAX_CROSS_SOURCE_CANDIDATE_WINDOW_MS)} ms`,
    );
  }
  return windowMs;
}

/** Generates only bounded, compatible Spotify/Last.fm pairs and is idempotent for one rule. */
export function generateCrossSourceCandidates(
  connection: SqliteConnection,
  options: CrossSourceCandidateGenerationOptions = {},
): CrossSourceCandidateGenerationSummary {
  const windowMs = validatedWindow(options.windowMs ?? DEFAULT_CROSS_SOURCE_CANDIDATE_WINDOW_MS);
  const parameters = {
    blockRadius: Math.ceil(windowMs / TIME_BLOCK_MS),
    normalizationVersion: MATCH_TEXT_NORMALIZATION_VERSION,
    windowMs,
  };
  const now = (options.now ?? (() => Date.now()))();

  return connection.transaction(() => {
    const pairs = connection
      .prepare<CandidatePairRow>(CROSS_SOURCE_CANDIDATE_PAIRS_SQL)
      .all(parameters);
    const insert = connection.prepare(
      `INSERT OR IGNORE INTO cross_source_candidate_generation
        (spotify_source_record_id, lastfm_source_record_id, candidate_reason,
         generation_rule_version, generated_at_epoch_ms)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const pair of pairs) {
      inserted += insert.run([
        pair.spotify_source_record_id,
        pair.lastfm_source_record_id,
        pair.candidate_reason,
        CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION,
        now,
      ]).changes;
    }
    return {
      inserted,
      existing: pairs.length - inserted,
      ruleVersion: CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION,
      windowMs,
    };
  });
}
