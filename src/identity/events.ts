import type { SqliteConnection, SqliteRow } from "../db/connection.ts";

/** Version of the initial one-event-per-source interpretation before reconciliation. */
export const CANONICAL_EVENT_RULE_VERSION = "canonical-event-v1";

interface EventEvidenceRow extends SqliteRow {
  readonly source_record_id: number;
  readonly track_id: number;
  readonly resolution_kind: string;
  readonly source_kind: "spotify" | "lastfm";
  readonly stopped_at_epoch_ms: number | null;
  readonly ms_played: number | null;
  readonly scrobbled_at_epoch_ms: number | null;
}

export interface CanonicalEventSummary {
  readonly processed: number;
  readonly current: number;
  readonly unresolved: number;
}

export interface ExactDuplicateCollapseSummary {
  readonly spotifyEventsCollapsed: number;
  readonly lastfmEventsCollapsed: number;
}

/**
 * Materializes one initial event for each resolved source occurrence not yet represented by an
 * event link. Exact duplicate source rows intentionally remain separate at this stage; P2-04
 * replaces those links with one shared event without deleting the evidence.
 */
export function createCanonicalEvents(connection: SqliteConnection): CanonicalEventSummary {
  return connection.transaction(() => {
    const evidence = connection
      .prepare<EventEvidenceRow>(
        `SELECT resolution.source_record_id,
                resolution.track_id,
                resolution.resolution_kind,
                source.source_kind,
                spotify.stopped_at_epoch_ms,
                spotify.ms_played,
                lastfm.scrobbled_at_epoch_ms
           FROM source_identity_resolution AS resolution
           JOIN source_record AS source ON source.id = resolution.source_record_id
           LEFT JOIN spotify_play_source AS spotify ON spotify.source_record_id = source.id
           LEFT JOIN lastfm_scrobble_occurrence AS occurrence ON occurrence.source_record_id = source.id
           LEFT JOIN lastfm_scrobble_source AS lastfm
             ON lastfm.source_record_id = occurrence.lastfm_scrobble_source_record_id
           LEFT JOIN listening_event_source AS event_source
             ON event_source.source_record_id = resolution.source_record_id
          WHERE event_source.source_record_id IS NULL
          ORDER BY resolution.source_record_id`,
      )
      .all();

    let current = 0;
    let unresolved = 0;
    for (const row of evidence) {
      const eventStatus = row.resolution_kind === "new_unresolved" ? "unresolved" : "current";
      const event =
        row.source_kind === "spotify"
          ? createSpotifyEvent(connection, row, eventStatus)
          : createLastfmEvent(connection, row, eventStatus);
      connection
        .prepare(
          "INSERT INTO listening_event_source (listening_event_id, source_record_id, evidence_role) VALUES (?, ?, 'primary')",
        )
        .run([event, row.source_record_id]);
      if (eventStatus === "current") current++;
      else unresolved++;
    }
    return { processed: evidence.length, current, unresolved };
  });
}

interface DuplicateEventLinkRow extends SqliteRow {
  readonly listening_event_id: number;
  readonly source_record_id: number;
}

/**
 * Collapses equivalent evidence occurrences created by the initial event pass. Source evidence is
 * retained; only its event interpretation changes. Spotify equivalence is its complete approved
 * source fingerprint. Last.fm equivalence is the existing shared source payload referenced by
 * occurrences, which lets a future API occurrence reuse the export event safely.
 */
export function collapseExactDuplicateEvents(
  connection: SqliteConnection,
): ExactDuplicateCollapseSummary {
  return connection.transaction(() => {
    const spotifyEventsCollapsed = collapseDuplicateGroups(
      connection,
      `SELECT spotify.source_fingerprint_sha256 AS duplicate_key
         FROM spotify_play_source AS spotify
         JOIN listening_event_source AS link ON link.source_record_id = spotify.source_record_id
        GROUP BY spotify.source_fingerprint_sha256
       HAVING count(*) > 1`,
      `SELECT link.listening_event_id, link.source_record_id
         FROM spotify_play_source AS spotify
         JOIN listening_event_source AS link ON link.source_record_id = spotify.source_record_id
        WHERE spotify.source_fingerprint_sha256 = ?
        ORDER BY link.listening_event_id, link.source_record_id`,
    );
    const lastfmEventsCollapsed = collapseDuplicateGroups(
      connection,
      `SELECT occurrence.lastfm_scrobble_source_record_id AS duplicate_key
         FROM lastfm_scrobble_occurrence AS occurrence
         JOIN listening_event_source AS link ON link.source_record_id = occurrence.source_record_id
        GROUP BY occurrence.lastfm_scrobble_source_record_id
       HAVING count(*) > 1`,
      `SELECT link.listening_event_id, link.source_record_id
         FROM lastfm_scrobble_occurrence AS occurrence
         JOIN listening_event_source AS link ON link.source_record_id = occurrence.source_record_id
        WHERE occurrence.lastfm_scrobble_source_record_id = ?
        ORDER BY link.listening_event_id, link.source_record_id`,
    );
    return { lastfmEventsCollapsed, spotifyEventsCollapsed };
  });
}

interface DuplicateKeyRow extends SqliteRow {
  readonly duplicate_key: number | string;
}

function collapseDuplicateGroups(
  connection: SqliteConnection,
  groupQuery: string,
  linkQuery: string,
): number {
  let collapsed = 0;
  for (const group of connection.prepare<DuplicateKeyRow>(groupQuery).all()) {
    const links = connection.prepare<DuplicateEventLinkRow>(linkQuery).all([group.duplicate_key]);
    const keeper = links[0];
    if (keeper === undefined) continue;

    for (const link of links.slice(1)) {
      if (link.listening_event_id === keeper.listening_event_id) continue;
      connection
        .prepare(
          `UPDATE listening_event_source
              SET listening_event_id = ?, evidence_role = 'exact_duplicate',
                  accepted_match_score = NULL, reconciliation_candidate_id = NULL
            WHERE listening_event_id = ? AND source_record_id = ?`,
        )
        .run([keeper.listening_event_id, link.listening_event_id, link.source_record_id]);

      const superseded = connection
        .prepare(
          `UPDATE listening_event
              SET event_status = 'superseded', superseded_by_event_id = ?
            WHERE id = ?
              AND event_status <> 'superseded'
              AND NOT EXISTS (
                SELECT 1 FROM listening_event_source AS existing_link
                 WHERE existing_link.listening_event_id = ?
              )`,
        )
        .run([keeper.listening_event_id, link.listening_event_id, link.listening_event_id]);
      collapsed += superseded.changes;
    }
  }
  return collapsed;
}

function createSpotifyEvent(
  connection: SqliteConnection,
  row: EventEvidenceRow,
  eventStatus: "current" | "unresolved",
): number {
  if (row.stopped_at_epoch_ms === null || row.ms_played === null) {
    throw new Error("Spotify source evidence is missing event timing");
  }
  return Number(
    connection
      .prepare(
        `INSERT INTO listening_event
          (track_id, started_at_epoch_ms, ended_at_epoch_ms, listened_ms, time_basis,
           event_status, reconciliation_rule_version)
         VALUES (?, ?, ?, ?, 'derived_start', ?, ?)`,
      )
      .run([
        row.track_id,
        row.stopped_at_epoch_ms - row.ms_played,
        row.stopped_at_epoch_ms,
        row.ms_played,
        eventStatus,
        CANONICAL_EVENT_RULE_VERSION,
      ]).lastInsertRowid,
  );
}

function createLastfmEvent(
  connection: SqliteConnection,
  row: EventEvidenceRow,
  eventStatus: "current" | "unresolved",
): number {
  if (row.scrobbled_at_epoch_ms === null) {
    throw new Error("Last.fm source evidence is missing event timing");
  }
  return Number(
    connection
      .prepare(
        `INSERT INTO listening_event
          (track_id, started_at_epoch_ms, ended_at_epoch_ms, listened_ms, time_basis,
           event_status, reconciliation_rule_version)
         VALUES (?, ?, NULL, NULL, 'observed_start', ?, ?)`,
      )
      .run([row.track_id, row.scrobbled_at_epoch_ms, eventStatus, CANONICAL_EVENT_RULE_VERSION])
      .lastInsertRowid,
  );
}
