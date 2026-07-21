import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import { createCanonicalEvents } from "../../../src/identity/events.ts";
import { resolveSourceIdentities } from "../../../src/identity/resolution.ts";
import { generateCrossSourceCandidates } from "../../../src/reconciliation/candidates.ts";
import {
  calculateCrossSourceMatchFeatures,
  CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION,
} from "../../../src/reconciliation/features.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
function fingerprint(id: number): string {
  return id.toString(16).padStart(64, "0");
}

type Connection = Parameters<typeof calculateCrossSourceMatchFeatures>[0];

function insertRun(connection: Connection): void {
  connection
    .prepare(
      "INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '7')",
    )
    .run();
}

function insertSpotify(
  connection: Connection,
  id: number,
  startedAt: number,
  artist: string,
  track: string,
  options: { readonly album?: string; readonly msPlayed?: number; readonly skipped?: 0 | 1 } = {},
): void {
  insertRun(connection);
  const msPlayed = options.msPlayed ?? 60_000;
  connection
    .prepare(
      "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'spotify', 1, 1)",
    )
    .run([id]);
  connection
    .prepare(
      `INSERT INTO spotify_play_source
        (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri, artist_name,
         album_name, track_name, shuffle, skipped, source_fingerprint_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run([
      id,
      startedAt + msPlayed,
      msPlayed,
      `spotify:track:synthetic-${String(id)}`,
      artist,
      options.album ?? null,
      track,
      options.skipped ?? null,
      fingerprint(id),
    ]);
}

function insertLastfm(
  connection: Connection,
  id: number,
  scrobbledAt: number,
  artist: string,
  track: string,
  options: {
    readonly album?: string;
    readonly occurrenceId?: number;
    readonly recordingId?: string;
  } = {},
): void {
  insertRun(connection);
  const occurrenceId = options.occurrenceId ?? id;
  if (occurrenceId !== id) {
    connection
      .prepare(
        "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'lastfm', 1, 1)",
      )
      .run([occurrenceId]);
  }
  connection
    .prepare(
      "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'lastfm', 1, 1)",
    )
    .run([id]);
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_source
        (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, album_name,
         track_name, recording_musicbrainz_id, source_fingerprint_sha256)
       VALUES (?, 'export', ?, ?, ?, ?, ?, ?)`,
    )
    .run([
      id,
      scrobbledAt,
      artist,
      options.album ?? null,
      track,
      options.recordingId ?? null,
      fingerprint(id),
    ]);
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_occurrence
        (source_record_id, lastfm_scrobble_source_record_id, source_origin)
       VALUES (?, ?, 'export')`,
    )
    .run([occurrenceId, id]);
}

function resolveEventsAndGenerate(connection: Connection): void {
  resolveSourceIdentities(connection, { now: () => 2 });
  createCanonicalEvents(connection);
  generateCrossSourceCandidates(connection, { now: () => 3, windowMs: 120_000 });
}

describe("cross-source match features", () => {
  it("scores a distinct Last.fm occurrence through its shared payload ID", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 100_000, "Artist", "Track");
      insertLastfm(connection, 2, 100_000, "Artist", "Track", { occurrenceId: 3 });
      resolveEventsAndGenerate(connection);

      assert.deepEqual(calculateCrossSourceMatchFeatures(connection), {
        inserted: 1,
        existing: 0,
        ruleVersion: CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION,
      });
      assert.deepEqual(
        connection
          .prepare(
            "SELECT spotify_source_record_id, lastfm_source_record_id FROM reconciliation_candidate",
          )
          .all(),
        [{ spotify_source_record_id: 1, lastfm_source_record_id: 2 }],
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

  it("persists exact and near-time features while treating missing albums and identifiers as unknown", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 100_000, "Artist", "Track", { album: "Album" });
      insertLastfm(connection, 2, 100_000, "Artist", "Track", { album: "Album" });
      insertSpotify(connection, 3, 200_000, "No Album", "Near Track");
      insertLastfm(connection, 4, 220_000, "No Album", "Near Track");
      resolveEventsAndGenerate(connection);

      assert.deepEqual(calculateCrossSourceMatchFeatures(connection), {
        inserted: 2,
        existing: 0,
        ruleVersion: CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION,
      });
      assert.deepEqual(
        connection
          .prepare(
            `SELECT spotify_source_record_id, identifier_agreement, album_score, start_delta_ms,
                    duration_score, short_play_score, total_confidence
               FROM reconciliation_candidate ORDER BY spotify_source_record_id`,
          )
          .all(),
        [
          {
            spotify_source_record_id: 1,
            identifier_agreement: null,
            album_score: 1,
            start_delta_ms: 0,
            duration_score: 1,
            short_play_score: 1,
            total_confidence: 1,
          },
          {
            spotify_source_record_id: 3,
            identifier_agreement: null,
            album_score: null,
            start_delta_ms: 20_000,
            duration_score: 0.6666666666666667,
            short_play_score: 1,
            total_confidence: 0.8333333333333331,
          },
        ],
      );
      assert.deepEqual(calculateCrossSourceMatchFeatures(connection), {
        inserted: 0,
        existing: 2,
        ruleVersion: CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION,
      });
    });
  });

  it("refreshes pending contextual scores when candidate generation adds a competitor", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 100_000, "Artist", "Track");
      insertLastfm(connection, 2, 100_000, "Artist", "Track");
      resolveEventsAndGenerate(connection);
      assert.equal(calculateCrossSourceMatchFeatures(connection).inserted, 1);

      insertLastfm(connection, 3, 105_000, "Artist", "Track");
      resolveEventsAndGenerate(connection);

      assert.deepEqual(calculateCrossSourceMatchFeatures(connection), {
        inserted: 1,
        existing: 1,
        ruleVersion: CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION,
      });
      assert.deepEqual(
        connection
          .prepare(
            `SELECT lastfm_source_record_id, ambiguity_score, competing_candidate_score
               FROM reconciliation_candidate
              WHERE spotify_source_record_id = 1
              ORDER BY lastfm_source_record_id`,
          )
          .all(),
        [
          {
            lastfm_source_record_id: 2,
            ambiguity_score: 0.5,
            competing_candidate_score: 0.5,
          },
          {
            lastfm_source_record_id: 3,
            ambiguity_score: 0.5,
            competing_candidate_score: 0.5,
          },
        ],
      );
    });
  });

  it("records identifier conflicts, short plays, reordered neighbors, and competing ties", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 100_000, "Conflict Artist", "Conflict Track", {
        msPlayed: 10_000,
        skipped: 1,
      });
      insertLastfm(connection, 2, 100_000, "Conflict Artist", "Conflict Track", {
        recordingId: "mbid-conflict",
      });
      insertSpotify(connection, 3, 300_000, "Second Artist", "Second Track");
      insertLastfm(connection, 4, 200_000, "Second Artist", "Second Track");
      insertLastfm(connection, 5, 105_000, "Conflict Artist", "Conflict Track");
      resolveEventsAndGenerate(connection);

      const artistId = connection
        .prepare<{ readonly artist_id: number }>(
          "SELECT artist_id FROM source_identity_resolution WHERE source_record_id = 2",
        )
        .get()?.artist_id;
      assert.notEqual(artistId, undefined);
      const conflictingTrackId = Number(
        connection
          .prepare(
            "INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('track', 4)",
          )
          .run().lastInsertRowid,
      );
      connection
        .prepare(
          "INSERT INTO track (id, artist_id, preferred_title) VALUES (?, ?, 'Conflict Track')",
        )
        .run([conflictingTrackId, artistId ?? null]);
      connection
        .prepare("UPDATE source_identity_resolution SET track_id = ? WHERE source_record_id = 2")
        .run([conflictingTrackId]);

      assert.equal(calculateCrossSourceMatchFeatures(connection).inserted, 3);
      assert.deepEqual(
        connection
          .prepare(
            `SELECT spotify_source_record_id, lastfm_source_record_id, identifier_agreement,
                    ordering_score, ambiguity_score, competing_candidate_score, short_play_score
               FROM reconciliation_candidate
              ORDER BY spotify_source_record_id, lastfm_source_record_id`,
          )
          .all(),
        [
          {
            spotify_source_record_id: 1,
            lastfm_source_record_id: 2,
            identifier_agreement: 0,
            ordering_score: 1,
            ambiguity_score: 0.5,
            competing_candidate_score: 0.5,
            short_play_score: 0,
          },
          {
            spotify_source_record_id: 1,
            lastfm_source_record_id: 5,
            identifier_agreement: null,
            ordering_score: 1,
            ambiguity_score: 0.5,
            competing_candidate_score: 0.5,
            short_play_score: 0,
          },
          {
            spotify_source_record_id: 3,
            lastfm_source_record_id: 4,
            identifier_agreement: null,
            ordering_score: 1,
            ambiguity_score: 0,
            competing_candidate_score: 1,
            short_play_score: 1,
          },
        ],
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

  it("marks a pair as reordered when its nearest independent neighbor reverses source order", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 100_000, "First Artist", "First Track");
      insertLastfm(connection, 2, 200_000, "First Artist", "First Track");
      insertSpotify(connection, 3, 200_000, "Second Artist", "Second Track");
      insertLastfm(connection, 4, 100_000, "Second Artist", "Second Track");
      resolveEventsAndGenerate(connection);

      assert.equal(calculateCrossSourceMatchFeatures(connection).inserted, 2);
      assert.deepEqual(
        connection
          .prepare(
            "SELECT ordering_score FROM reconciliation_candidate ORDER BY spotify_source_record_id",
          )
          .all(),
        [{ ordering_score: 0 }, { ordering_score: 0 }],
      );
    });
  });

  it("leaves ordering unknown when either source timestamp is tied", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 100_000, "First Artist", "First Track");
      insertLastfm(connection, 2, 100_000, "First Artist", "First Track");
      insertSpotify(connection, 3, 100_000, "Second Artist", "Second Track");
      insertLastfm(connection, 4, 110_000, "Second Artist", "Second Track");
      resolveEventsAndGenerate(connection);

      assert.equal(calculateCrossSourceMatchFeatures(connection).inserted, 2);
      assert.deepEqual(
        connection
          .prepare(
            "SELECT ordering_score FROM reconciliation_candidate ORDER BY spotify_source_record_id",
          )
          .all(),
        [{ ordering_score: null }, { ordering_score: null }],
      );
    });
  });

  it("rolls back every feature row when one candidate cannot be persisted", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 100_000, "First Artist", "First Track");
      insertLastfm(connection, 2, 100_000, "First Artist", "First Track");
      insertSpotify(connection, 3, 200_000, "Second Artist", "Second Track");
      insertLastfm(connection, 4, 200_000, "Second Artist", "Second Track");
      resolveEventsAndGenerate(connection);
      connection.execute(
        `CREATE TRIGGER reject_second_feature_candidate
           BEFORE INSERT ON reconciliation_candidate
           WHEN (SELECT count(*) FROM reconciliation_candidate) = 1
         BEGIN
           SELECT RAISE(ABORT, 'synthetic feature persistence failure');
         END`,
      );

      assert.throws(
        () => calculateCrossSourceMatchFeatures(connection),
        /synthetic feature persistence failure/,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM reconciliation_candidate").get()?.count,
        0,
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });
});
