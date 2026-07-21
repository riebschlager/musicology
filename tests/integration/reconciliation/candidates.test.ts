import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import { createCanonicalEvents } from "../../../src/identity/events.ts";
import { resolveSourceIdentities } from "../../../src/identity/resolution.ts";
import {
  CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION,
  CROSS_SOURCE_CANDIDATE_PAIRS_SQL,
  generateCrossSourceCandidates,
} from "../../../src/reconciliation/candidates.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
function fingerprint(id: number): string {
  return id.toString(16).padStart(64, "0");
}

function insertRun(connection: Parameters<typeof generateCrossSourceCandidates>[0]): void {
  connection
    .prepare(
      "INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '6')",
    )
    .run();
}

function insertSpotify(
  connection: Parameters<typeof generateCrossSourceCandidates>[0],
  id: number,
  startedAtEpochMs: number,
  artistName: string,
  trackName: string,
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
         track_name, shuffle, source_fingerprint_sha256)
       VALUES (?, ?, 1000, ?, ?, ?, 0, ?)`,
    )
    .run([
      id,
      startedAtEpochMs + 1000,
      `spotify:track:synthetic-${String(id)}`,
      artistName,
      trackName,
      fingerprint(id),
    ]);
}

function insertLastfm(
  connection: Parameters<typeof generateCrossSourceCandidates>[0],
  id: number,
  scrobbledAtEpochMs: number,
  artistName: string,
  trackName: string,
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
         source_fingerprint_sha256)
       VALUES (?, 'export', ?, ?, ?, ?)`,
    )
    .run([id, scrobbledAtEpochMs, artistName, trackName, fingerprint(id)]);
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_occurrence
        (source_record_id, lastfm_scrobble_source_record_id, source_origin)
       VALUES (?, ?, 'export')`,
    )
    .run([id, id]);
}

function resolveAndCreateEvents(
  connection: Parameters<typeof generateCrossSourceCandidates>[0],
): void {
  resolveSourceIdentities(connection, { now: () => 2 });
  createCanonicalEvents(connection);
}

describe("cross-source candidate generation", () => {
  it("stores bounded compatible pairs with their reason and generation rule, idempotently", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 100_000, "Matching Artist", "Matching Track");
      insertLastfm(connection, 2, 115_000, "Matching Artist", "Matching Track");
      insertLastfm(connection, 3, 105_000, "Other Artist", "Other Track");
      insertLastfm(connection, 4, 131_000, "Matching Artist", "Matching Track");
      resolveAndCreateEvents(connection);

      assert.deepEqual(generateCrossSourceCandidates(connection, { now: () => 9 }), {
        inserted: 1,
        existing: 0,
        ruleVersion: CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION,
        windowMs: 30_000,
      });
      assert.deepEqual(generateCrossSourceCandidates(connection, { now: () => 10 }), {
        inserted: 0,
        existing: 1,
        ruleVersion: CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION,
        windowMs: 30_000,
      });
      assert.deepEqual(
        connection
          .prepare(
            `SELECT spotify_source_record_id, lastfm_source_record_id, candidate_reason,
                    generation_rule_version, generated_at_epoch_ms
               FROM cross_source_candidate_generation`,
          )
          .all(),
        [
          {
            spotify_source_record_id: 1,
            lastfm_source_record_id: 2,
            candidate_reason: "shared_track_identity",
            generation_rule_version: CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION,
            generated_at_epoch_ms: 9,
          },
        ],
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

  it("rolls back every candidate when a later candidate insert fails", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 100_000, "First Artist", "First Track");
      insertLastfm(connection, 2, 100_000, "First Artist", "First Track");
      insertSpotify(connection, 3, 200_000, "Second Artist", "Second Track");
      insertLastfm(connection, 4, 200_000, "Second Artist", "Second Track");
      resolveAndCreateEvents(connection);
      connection.execute(
        `CREATE TRIGGER reject_second_generated_candidate
           BEFORE INSERT ON cross_source_candidate_generation
           WHEN (SELECT count(*) FROM cross_source_candidate_generation) = 1
         BEGIN
           SELECT RAISE(ABORT, 'synthetic candidate generation failure');
         END`,
      );

      assert.throws(
        () => generateCrossSourceCandidates(connection, { now: () => 9 }),
        /synthetic candidate generation failure/,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM cross_source_candidate_generation").get()
          ?.count,
        0,
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

  it("honors zero and inclusive time windows across adjacent minute blocks", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 59_999, "Adjacent Artist", "Adjacent Track");
      insertLastfm(connection, 2, 60_001, "Adjacent Artist", "Adjacent Track");
      insertSpotify(connection, 3, 100_000, "Boundary Artist", "Boundary Track");
      insertLastfm(connection, 4, 130_000, "Boundary Artist", "Boundary Track");
      insertSpotify(connection, 5, 200_000, "Exact Artist", "Exact Track");
      insertLastfm(connection, 6, 200_000, "Exact Artist", "Exact Track");
      insertSpotify(connection, 7, 300_000, "Near Artist", "Near Track");
      insertLastfm(connection, 8, 300_001, "Near Artist", "Near Track");
      resolveAndCreateEvents(connection);

      assert.deepEqual(generateCrossSourceCandidates(connection, { now: () => 9, windowMs: 0 }), {
        inserted: 1,
        existing: 0,
        ruleVersion: CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION,
        windowMs: 0,
      });
      assert.deepEqual(generateCrossSourceCandidates(connection, { now: () => 10 }), {
        inserted: 3,
        existing: 1,
        ruleVersion: CROSS_SOURCE_CANDIDATE_GENERATION_RULE_VERSION,
        windowMs: 30_000,
      });
      assert.deepEqual(
        connection
          .prepare(
            `SELECT spotify_source_record_id, lastfm_source_record_id
               FROM cross_source_candidate_generation
              ORDER BY spotify_source_record_id`,
          )
          .all(),
        [
          { spotify_source_record_id: 1, lastfm_source_record_id: 2 },
          { spotify_source_record_id: 3, lastfm_source_record_id: 4 },
          { spotify_source_record_id: 5, lastfm_source_record_id: 6 },
          { spotify_source_record_id: 7, lastfm_source_record_id: 8 },
        ],
      );
    });
  });

  it("uses matching normalized artist and track aliases when identities remain separate", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertSpotify(connection, 1, 100_000, "Fallback Artist", "Fallback Track");
      insertLastfm(connection, 2, 100_000, "Fallback Artist", "Fallback Track");
      resolveAndCreateEvents(connection);

      const artistId = Number(
        connection
          .prepare(
            "INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('artist', 3)",
          )
          .run().lastInsertRowid,
      );
      connection
        .prepare("INSERT INTO artist (id, preferred_name) VALUES (?, 'Fallback Artist')")
        .run([artistId]);
      const trackId = Number(
        connection
          .prepare(
            "INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('track', 3)",
          )
          .run().lastInsertRowid,
      );
      connection
        .prepare(
          "INSERT INTO track (id, artist_id, preferred_title) VALUES (?, ?, 'Fallback Track')",
        )
        .run([trackId, artistId]);
      connection
        .prepare(
          `INSERT INTO artist_alias
            (artist_id, display_alias, normalized_alias, normalization_version, alias_source, source_record_id)
           VALUES (?, 'Fallback Artist', 'fallback artist', 'match-text-v1', 'source', 2)`,
        )
        .run([artistId]);
      connection
        .prepare(
          `INSERT INTO track_alias
            (track_id, display_alias, normalized_alias, normalization_version, source_record_id)
           VALUES (?, 'Fallback Track', 'fallback track', 'match-text-v1', 2)`,
        )
        .run([trackId]);
      connection
        .prepare(
          "UPDATE source_identity_resolution SET artist_id = ?, track_id = ? WHERE source_record_id = 2",
        )
        .run([artistId, trackId]);

      assert.equal(generateCrossSourceCandidates(connection, { now: () => 9 }).inserted, 1);
      assert.deepEqual(
        connection.prepare("SELECT candidate_reason FROM cross_source_candidate_generation").all(),
        [{ candidate_reason: "matching_normalized_artist_track" }],
      );
    });
  });

  it("uses an indexed time-block search instead of an all-pairs scan at representative volume", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (let index = 1; index <= 120; index++) {
        insertSpotify(
          connection,
          index,
          index * 60_000,
          `Artist ${String(index)}`,
          `Track ${String(index)}`,
        );
        insertLastfm(
          connection,
          index + 200,
          index * 60_000,
          `Artist ${String(index)}`,
          `Track ${String(index)}`,
        );
      }
      resolveAndCreateEvents(connection);
      const plan = connection
        .prepare(`EXPLAIN QUERY PLAN ${CROSS_SOURCE_CANDIDATE_PAIRS_SQL}`)
        .all({ blockRadius: 1, normalizationVersion: "match-text-v1", windowMs: 30_000 })
        .map((row) => String(row.detail))
        .join("\n");

      assert.match(plan, /lastfm_scrobble_source_time_block_idx/);
      assert.doesNotMatch(plan, /SCAN lastfm_scrobble_source AS lastfm/);
    });
  });

  it("rejects windows outside the conservative configured bound", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      assert.throws(
        () => generateCrossSourceCandidates(connection, { windowMs: 120_001 }),
        /must be an integer from 0 to 120000 ms/,
      );
    });
  });
});
