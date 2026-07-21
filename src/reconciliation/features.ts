import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import { normalizeMatchText } from "../identity/normalization.ts";
import { CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION } from "./candidates.ts";

/** Version of the deterministic P2-06 feature definitions and aggregate calculation. */
export const CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION = "cross-source-match-feature-v1";
const SHORT_PLAY_THRESHOLD_MS = 30_000;
const TIME_SCORE_FLOOR_MS = 30_000;

export interface CrossSourceMatchFeatureSummary {
  readonly inserted: number;
  readonly existing: number;
  readonly ruleVersion: typeof CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION;
}

interface GeneratedPairRow extends SqliteRow {
  readonly spotify_source_record_id: number;
  readonly lastfm_source_record_id: number;
  readonly spotify_track_id: number;
  readonly lastfm_track_id: number;
  readonly spotify_artist_id: number;
  readonly lastfm_artist_id: number;
  readonly spotify_started_at_epoch_ms: number;
  readonly spotify_ms_played: number;
  readonly spotify_skipped: number | null;
  readonly spotify_artist_name: string;
  readonly spotify_track_name: string;
  readonly spotify_album_name: string | null;
  readonly lastfm_scrobbled_at_epoch_ms: number;
  readonly lastfm_artist_name: string;
  readonly lastfm_track_name: string;
  readonly lastfm_album_name: string | null;
  readonly lastfm_recording_musicbrainz_id: string | null;
}

interface CandidateFeature {
  readonly identifierAgreement: 0 | 1 | null;
  readonly artistScore: number;
  readonly trackScore: number;
  readonly albumScore: number | null;
  readonly startDeltaMs: number;
  readonly durationScore: number;
  readonly orderingScore: number | null;
  readonly ambiguityScore: number;
  readonly competingCandidateScore: number;
  readonly shortPlayScore: number;
  readonly totalConfidence: number;
}

/**
 * P2-06's candidate feature pass. It stores evidence-derived features only; later policy work
 * decides which confidence ranges can merge. Re-running against unchanged generated candidates is
 * a no-op; pending rows are refreshed when later generation changes their contextual features.
 */
export function calculateCrossSourceMatchFeatures(
  connection: SqliteConnection,
): CrossSourceMatchFeatureSummary {
  return connection.transaction(() => {
    const pairs = connection.prepare<GeneratedPairRow>(GENERATED_PAIRS_SQL).all({
      generationRuleVersion: CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION,
    });
    const features = calculateFeatures(pairs);
    const existingCandidate = connection.prepare(
      `SELECT id
         FROM reconciliation_candidate
        WHERE spotify_source_record_id = ?
          AND lastfm_source_record_id = ?
          AND rule_version = ?`,
    );
    const insertOrRefresh = connection.prepare(
      `INSERT INTO reconciliation_candidate
        (spotify_source_record_id, lastfm_source_record_id, identifier_agreement, artist_score,
         track_score, album_score, start_delta_ms, duration_score, ordering_score,
         ambiguity_score, competing_candidate_score, short_play_score, total_confidence,
         rule_version, candidate_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT (spotify_source_record_id, lastfm_source_record_id, rule_version) DO UPDATE SET
         identifier_agreement = excluded.identifier_agreement,
         artist_score = excluded.artist_score,
         track_score = excluded.track_score,
         album_score = excluded.album_score,
         start_delta_ms = excluded.start_delta_ms,
         duration_score = excluded.duration_score,
         ordering_score = excluded.ordering_score,
         ambiguity_score = excluded.ambiguity_score,
         competing_candidate_score = excluded.competing_candidate_score,
         short_play_score = excluded.short_play_score,
         total_confidence = excluded.total_confidence
       WHERE reconciliation_candidate.candidate_state = 'pending'
         AND (
           reconciliation_candidate.identifier_agreement IS NOT excluded.identifier_agreement OR
           reconciliation_candidate.artist_score IS NOT excluded.artist_score OR
           reconciliation_candidate.track_score IS NOT excluded.track_score OR
           reconciliation_candidate.album_score IS NOT excluded.album_score OR
           reconciliation_candidate.start_delta_ms IS NOT excluded.start_delta_ms OR
           reconciliation_candidate.duration_score IS NOT excluded.duration_score OR
           reconciliation_candidate.ordering_score IS NOT excluded.ordering_score OR
           reconciliation_candidate.ambiguity_score IS NOT excluded.ambiguity_score OR
           reconciliation_candidate.competing_candidate_score IS NOT excluded.competing_candidate_score OR
           reconciliation_candidate.short_play_score IS NOT excluded.short_play_score OR
           reconciliation_candidate.total_confidence IS NOT excluded.total_confidence
         )`,
    );
    let inserted = 0;
    for (const [pair, feature] of pairs.map((pair, index) => [pair, features[index]] as const)) {
      if (feature === undefined) continue;
      const alreadyExists =
        existingCandidate.get([
          pair.spotify_source_record_id,
          pair.lastfm_source_record_id,
          CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION,
        ]) !== undefined;
      const result = insertOrRefresh.run([
        pair.spotify_source_record_id,
        pair.lastfm_source_record_id,
        feature.identifierAgreement,
        feature.artistScore,
        feature.trackScore,
        feature.albumScore,
        feature.startDeltaMs,
        feature.durationScore,
        feature.orderingScore,
        feature.ambiguityScore,
        feature.competingCandidateScore,
        feature.shortPlayScore,
        feature.totalConfidence,
        CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION,
      ]);
      if (!alreadyExists) inserted += result.changes;
    }
    return {
      existing: pairs.length - inserted,
      inserted,
      ruleVersion: CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION,
    };
  });
}

function calculateFeatures(pairs: readonly GeneratedPairRow[]): readonly CandidateFeature[] {
  const spotifyCounts = countBy(pairs, (pair) => pair.spotify_source_record_id);
  const lastfmCounts = countBy(pairs, (pair) => pair.lastfm_source_record_id);
  return pairs.map((pair, index) => {
    const startDeltaMs = pair.lastfm_scrobbled_at_epoch_ms - pair.spotify_started_at_epoch_ms;
    const competingCandidateScore =
      1 /
      Math.max(
        spotifyCounts.get(pair.spotify_source_record_id) ?? 1,
        lastfmCounts.get(pair.lastfm_source_record_id) ?? 1,
      );
    const feature: Omit<CandidateFeature, "totalConfidence"> = {
      identifierAgreement: identifierAgreement(pair),
      artistScore: textScore(
        pair.spotify_artist_name,
        pair.lastfm_artist_name,
        pair.spotify_artist_id === pair.lastfm_artist_id,
      ),
      trackScore: textScore(
        pair.spotify_track_name,
        pair.lastfm_track_name,
        pair.spotify_track_id === pair.lastfm_track_id,
      ),
      albumScore: albumScore(pair.spotify_album_name, pair.lastfm_album_name),
      startDeltaMs,
      durationScore: Math.max(
        0,
        1 - Math.abs(startDeltaMs) / Math.max(pair.spotify_ms_played, TIME_SCORE_FLOOR_MS),
      ),
      orderingScore: orderingScore(pairs, index),
      ambiguityScore: 1 - competingCandidateScore,
      competingCandidateScore,
      shortPlayScore:
        pair.spotify_ms_played >= SHORT_PLAY_THRESHOLD_MS && pair.spotify_skipped !== 1 ? 1 : 0,
    };
    return { ...feature, totalConfidence: aggregateConfidence(feature) };
  });
}

function identifierAgreement(pair: GeneratedPairRow): 0 | 1 | null {
  // Spotify provides a trusted track URI for every accepted row. A Last.fm recording MBID makes
  // this a directly comparable strong-identifier feature; absent MBIDs are unknown, not negative.
  if (pair.lastfm_recording_musicbrainz_id === null) return null;
  return pair.spotify_track_id === pair.lastfm_track_id ? 1 : 0;
}

function textScore(left: string, right: string, sameResolvedIdentity: boolean): number {
  if (normalizeMatchText(left) === normalizeMatchText(right)) return 1;
  return sameResolvedIdentity ? 0.75 : 0;
}

function albumScore(left: string | null, right: string | null): number | null {
  if (left === null || right === null) return null;
  return normalizeMatchText(left) === normalizeMatchText(right) ? 1 : 0;
}

function orderingScore(pairs: readonly GeneratedPairRow[], index: number): number | null {
  const current = pairs[index];
  if (current === undefined) return null;
  const neighbors = pairs
    .map((pair, neighborIndex) => ({ pair, neighborIndex }))
    .filter(
      ({ pair, neighborIndex }) =>
        neighborIndex !== index &&
        pair.spotify_source_record_id !== current.spotify_source_record_id &&
        pair.lastfm_source_record_id !== current.lastfm_source_record_id,
    )
    .sort(
      (left, right) =>
        Math.abs(left.pair.spotify_started_at_epoch_ms - current.spotify_started_at_epoch_ms) -
        Math.abs(right.pair.spotify_started_at_epoch_ms - current.spotify_started_at_epoch_ms),
    );
  const neighbor = neighbors[0]?.pair;
  if (neighbor === undefined) return null;
  const spotifyOrder = Math.sign(
    current.spotify_started_at_epoch_ms - neighbor.spotify_started_at_epoch_ms,
  );
  const lastfmOrder = Math.sign(
    current.lastfm_scrobbled_at_epoch_ms - neighbor.lastfm_scrobbled_at_epoch_ms,
  );
  if (spotifyOrder === 0 || lastfmOrder === 0) return null;
  return spotifyOrder === lastfmOrder ? 1 : 0;
}

function aggregateConfidence(feature: Omit<CandidateFeature, "totalConfidence">): number {
  const weighted = [
    [feature.identifierAgreement, 0.25],
    [feature.artistScore, 0.15],
    [feature.trackScore, 0.2],
    [feature.albumScore, 0.1],
    [1 - Math.min(1, Math.abs(feature.startDeltaMs) / TIME_SCORE_FLOOR_MS), 0.15],
    [feature.durationScore, 0.05],
    [feature.orderingScore, 0.05],
    [feature.competingCandidateScore, 0.05],
    [feature.shortPlayScore, 0.05],
  ] as const;
  const present = weighted.filter(([value]) => value !== null);
  const totalWeight = present.reduce((total, [, weight]) => total + weight, 0);
  return present.reduce((total, [value, weight]) => total + (value ?? 0) * weight, 0) / totalWeight;
}

function countBy(
  pairs: readonly GeneratedPairRow[],
  key: (pair: GeneratedPairRow) => number,
): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const pair of pairs) counts.set(key(pair), (counts.get(key(pair)) ?? 0) + 1);
  return counts;
}

const GENERATED_PAIRS_SQL = `
  SELECT generated.spotify_source_record_id,
         generated.lastfm_source_record_id,
         spotify_resolution.track_id AS spotify_track_id,
         lastfm_resolution.track_id AS lastfm_track_id,
         spotify_resolution.artist_id AS spotify_artist_id,
         lastfm_resolution.artist_id AS lastfm_artist_id,
         spotify.stopped_at_epoch_ms - spotify.ms_played AS spotify_started_at_epoch_ms,
         spotify.ms_played AS spotify_ms_played,
         spotify.skipped AS spotify_skipped,
         spotify.artist_name AS spotify_artist_name,
         spotify.track_name AS spotify_track_name,
         spotify.album_name AS spotify_album_name,
         lastfm.scrobbled_at_epoch_ms AS lastfm_scrobbled_at_epoch_ms,
         lastfm.artist_name AS lastfm_artist_name,
         lastfm.track_name AS lastfm_track_name,
         lastfm.album_name AS lastfm_album_name,
         lastfm.recording_musicbrainz_id AS lastfm_recording_musicbrainz_id
    FROM cross_source_candidate_generation AS generated
    JOIN spotify_play_source AS spotify
      ON spotify.source_record_id = generated.spotify_source_record_id
    JOIN source_identity_resolution AS spotify_resolution
      ON spotify_resolution.source_record_id = spotify.source_record_id
    JOIN lastfm_scrobble_source AS lastfm
      ON lastfm.source_record_id = generated.lastfm_source_record_id
    JOIN lastfm_scrobble_occurrence AS occurrence
      ON occurrence.lastfm_scrobble_source_record_id = lastfm.source_record_id
    JOIN source_identity_resolution AS lastfm_resolution
      ON lastfm_resolution.source_record_id = occurrence.source_record_id
    JOIN listening_event_source AS lastfm_link
      ON lastfm_link.source_record_id = occurrence.source_record_id
     AND lastfm_link.evidence_role = 'primary'
    JOIN listening_event AS lastfm_event
      ON lastfm_event.id = lastfm_link.listening_event_id
     AND lastfm_event.event_status IN ('current', 'unresolved')
   WHERE generated.generation_rule_version = @generationRuleVersion
   ORDER BY generated.spotify_source_record_id, generated.lastfm_source_record_id
`;
