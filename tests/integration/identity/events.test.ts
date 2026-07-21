import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import {
  CANONICAL_EVENT_RULE_VERSION,
  createCanonicalEvents,
} from "../../../src/identity/events.ts";
import { resolveSourceIdentities } from "../../../src/identity/resolution.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const hash = "a".repeat(64);

function insertRun(connection: Parameters<typeof createCanonicalEvents>[0]): void {
  connection
    .prepare(
      "INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '5')",
    )
    .run();
}

function insertLastfmSource(
  connection: Parameters<typeof createCanonicalEvents>[0],
  id: number,
  recordingId: string | null,
  artistName = "Synthetic Artist",
  trackName = "Synthetic Track",
): void {
  insertRun(connection);
  connection
    .prepare(
      "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'lastfm', 1, 1)",
    )
    .run([id]);
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_source
        (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name,
         recording_musicbrainz_id, source_fingerprint_sha256)
       VALUES (?, 'export', ?, ?, ?, ?, ?)`,
    )
    .run([
      id,
      id * 1_000,
      artistName,
      trackName,
      recordingId,
      `${String(id).padStart(2, "0")}${hash.slice(2)}`,
    ]);
  connection
    .prepare(
      "INSERT INTO lastfm_scrobble_occurrence (source_record_id, lastfm_scrobble_source_record_id, source_origin) VALUES (?, ?, 'export')",
    )
    .run([id, id]);
}

function insertSpotifySource(
  connection: Parameters<typeof createCanonicalEvents>[0],
  id: number,
  msPlayed: number,
  sourceFingerprint = `${String(id).padStart(2, "0")}${hash.slice(2)}`,
): void {
  insertRun(connection);
  connection
    .prepare(
      "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'spotify', 1, 1)",
    )
    .run([id]);
  connection
    .prepare(
      `INSERT INTO spotify_play_source
        (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri, artist_name,
         track_name, shuffle, skipped, source_fingerprint_sha256)
       VALUES (?, 10000, ?, 'spotify:track:synthetic', 'Synthetic Artist', 'Synthetic Track',
               0, 1, ?)`,
    )
    .run([id, msPlayed, sourceFingerprint]);
}

describe("canonical event creation", () => {
  it("creates a provenance-backed event for every resolved source record and is idempotent", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotifySource(connection, 1, 250);
      insertLastfmSource(connection, 2, "recording-2");
      insertLastfmSource(connection, 3, null, "Unresolved Artist", "Unresolved Track");
      resolveSourceIdentities(connection, { now: () => 4 });

      assert.deepEqual(createCanonicalEvents(connection), {
        processed: 3,
        current: 2,
        unresolved: 1,
      });
      assert.deepEqual(createCanonicalEvents(connection), {
        processed: 0,
        current: 0,
        unresolved: 0,
      });
      assert.deepEqual(
        connection
          .prepare(
            `SELECT source.id AS source_record_id, event.started_at_epoch_ms, event.ended_at_epoch_ms,
                    event.listened_ms, event.time_basis, event.event_status,
                    event.reconciliation_rule_version, link.evidence_role
               FROM source_record AS source
               JOIN listening_event_source AS link ON link.source_record_id = source.id
               JOIN listening_event AS event ON event.id = link.listening_event_id
              ORDER BY source.id`,
          )
          .all(),
        [
          {
            source_record_id: 1,
            started_at_epoch_ms: 9750,
            ended_at_epoch_ms: 10000,
            listened_ms: 250,
            time_basis: "derived_start",
            event_status: "current",
            reconciliation_rule_version: CANONICAL_EVENT_RULE_VERSION,
            evidence_role: "primary",
          },
          {
            source_record_id: 2,
            started_at_epoch_ms: 2000,
            ended_at_epoch_ms: null,
            listened_ms: null,
            time_basis: "observed_start",
            event_status: "current",
            reconciliation_rule_version: CANONICAL_EVENT_RULE_VERSION,
            evidence_role: "primary",
          },
          {
            source_record_id: 3,
            started_at_epoch_ms: 3000,
            ended_at_epoch_ms: null,
            listened_ms: null,
            time_basis: "observed_start",
            event_status: "unresolved",
            reconciliation_rule_version: CANONICAL_EVENT_RULE_VERSION,
            evidence_role: "primary",
          },
        ],
      );
      assert.equal(
        connection
          .prepare(
            `SELECT count(*) AS count
               FROM source_identity_resolution AS resolution
               LEFT JOIN listening_event_source AS link ON link.source_record_id = resolution.source_record_id
              WHERE link.source_record_id IS NULL`,
          )
          .get()?.count,
        0,
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

  it("rolls back event and provenance writes when a later event cannot be inserted", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertLastfmSource(connection, 1, "recording-1");
      insertLastfmSource(connection, 2, "recording-2");
      resolveSourceIdentities(connection, { now: () => 3 });
      connection.execute(
        `CREATE TRIGGER reject_second_event
           BEFORE INSERT ON listening_event
           WHEN (SELECT count(*) FROM listening_event) = 1
         BEGIN
           SELECT RAISE(ABORT, 'synthetic event failure');
         END`,
      );

      assert.throws(() => createCanonicalEvents(connection), /synthetic event failure/);
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM listening_event").get()?.count,
        0,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM listening_event_source").get()?.count,
        0,
      );
    });
  });

  it("keeps exact Spotify duplicate evidence as separate events until P2-04", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const duplicateFingerprint = "b".repeat(64);
      insertSpotifySource(connection, 1, 250, duplicateFingerprint);
      insertSpotifySource(connection, 2, 250, duplicateFingerprint);
      resolveSourceIdentities(connection, { now: () => 3 });

      assert.deepEqual(createCanonicalEvents(connection), {
        processed: 2,
        current: 2,
        unresolved: 0,
      });
      assert.deepEqual(
        connection
          .prepare(
            `SELECT event.id AS listening_event_id, link.source_record_id, link.evidence_role
               FROM listening_event AS event
               JOIN listening_event_source AS link ON link.listening_event_id = event.id
              ORDER BY link.source_record_id`,
          )
          .all(),
        [
          { listening_event_id: 1, source_record_id: 1, evidence_role: "primary" },
          { listening_event_id: 2, source_record_id: 2, evidence_role: "primary" },
        ],
      );
    });
  });
});
