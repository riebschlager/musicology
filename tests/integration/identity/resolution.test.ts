import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import { MATCH_TEXT_NORMALIZATION_VERSION } from "../../../src/identity/normalization.ts";
import {
  IDENTITY_RESOLUTION_RULE_VERSION,
  resolveSourceIdentities,
} from "../../../src/identity/resolution.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const hash = "a".repeat(64);
type SourceRecordArguments = readonly [number, string, string, string | null, string | null];

function sourceRecord(
  connection: Parameters<typeof resolveSourceIdentities>[0],
  id: number,
  artist: string,
  track: string,
  album: string | null,
  recordingId: string | null,
): void {
  connection
    .prepare(
      "INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '5')",
    )
    .run();
  connection
    .prepare(
      "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'lastfm', 1, 1)",
    )
    .run([id]);
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_source (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, album_name, track_name, recording_musicbrainz_id, source_fingerprint_sha256) VALUES (?, 'export', ?, ?, ?, ?, ?, ?)`,
    )
    .run([
      id,
      id,
      artist,
      album,
      track,
      recordingId,
      `${String(id).padStart(2, "0")}${hash.slice(2)}`,
    ]);
  connection
    .prepare(
      "INSERT INTO lastfm_scrobble_occurrence (source_record_id, lastfm_scrobble_source_record_id, source_origin) VALUES (?, ?, 'export')",
    )
    .run([id, id]);
}

function snapshot(order: readonly number[]): readonly Record<string, unknown>[] {
  return withTemporarySqliteDatabase(({ connection }) => {
    applyMigrations(connection, migrationsDirectory);
    const records: readonly SourceRecordArguments[] = [
      [1, "Beyoncé", "Halo", "I Am... Sasha Fierce", "recording-1"],
      [2, "Beyonce\u0301", "Halo", "I Am... Sasha Fierce", "recording-1"],
      [3, "Beyoncé", "Single", null, null],
    ];
    for (const index of order) {
      const record = records[index - 1];
      if (record === undefined) {
        throw new Error("Test record is missing");
      }
      sourceRecord(connection, ...record);
    }
    assert.deepEqual(resolveSourceIdentities(connection, { now: () => 5 }), {
      processed: 3,
      resolved: 3,
      conflicts: 0,
    });
    assert.equal(resolveSourceIdentities(connection, { now: () => 6 }).processed, 0);
    return connection
      .prepare(
        `SELECT artist.preferred_name AS artist, track.preferred_title AS track, release.preferred_title AS release, resolution.resolution_kind AS kind FROM source_identity_resolution AS resolution JOIN artist ON artist.id=resolution.artist_id JOIN track ON track.id=resolution.track_id LEFT JOIN release ON release.id=resolution.release_id ORDER BY track, release`,
      )
      .all();
  });
}

describe("identity resolution", () => {
  it("is order-independent, reuses trusted identifiers, and leaves a missing album unknown", () => {
    assert.deepEqual(snapshot([1, 2, 3]), snapshot([3, 2, 1]));
    assert.deepEqual(snapshot([1, 2, 3]), [
      {
        artist: "Beyoncé",
        track: "Halo",
        release: "I Am... Sasha Fierce",
        kind: "trusted_identifier",
      },
      {
        artist: "Beyoncé",
        track: "Halo",
        release: "I Am... Sasha Fierce",
        kind: "trusted_identifier",
      },
      { artist: "Beyoncé", track: "Single", release: null, kind: "known_alias" },
    ]);
  });

  it("records rather than merges a strong-identifier conflict", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      sourceRecord(connection, 1, "Artist One", "Song", null, "recording-one");
      sourceRecord(connection, 2, "Artist Two", "Song", null, "recording-two");
      resolveSourceIdentities(connection, { now: () => 5 });
      sourceRecord(connection, 3, "Artist One", "Song", null, "recording-two");
      const result = resolveSourceIdentities(connection, { now: () => 6 });
      assert.equal(result.conflicts, 2);
      assert.deepEqual(
        connection
          .prepare("SELECT entity_type FROM identity_resolution_conflict ORDER BY entity_type")
          .all(),
        [{ entity_type: "artist" }, { entity_type: "track" }],
      );
      assert.equal(connection.prepare("SELECT count(*) AS count FROM track").get()?.count, 2);
      assert.deepEqual(
        connection
          .prepare(
            `SELECT resolution.artist_id = track.artist_id AS is_consistent FROM source_identity_resolution AS resolution JOIN track ON track.id = resolution.track_id WHERE resolution.source_record_id = 3`,
          )
          .all(),
        [{ is_consistent: 1 }],
      );
    });
  });

  it("uses an unambiguous manual alias before a conflicting source alias", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      sourceRecord(connection, 1, "Artist One", "First Song", null, "recording-one");
      sourceRecord(connection, 2, "Artist Two", "Second Song", null, "recording-two");
      resolveSourceIdentities(connection, { now: () => 5 });

      const artistTwoId = connection
        .prepare<{ readonly id: number }>(
          "SELECT id FROM artist WHERE preferred_name = 'Artist Two'",
        )
        .get()?.id;
      if (artistTwoId === undefined) {
        throw new Error("Artist Two is missing from the fixture");
      }
      const decisionId = Number(
        connection
          .prepare(
            "INSERT INTO identity_decision (decision_type, subject_entity_id, alias_text, decided_at_epoch_ms, decision_version, rationale) VALUES ('alias', ?, 'Artist One', 6, 'manual-v1', 'fixture')",
          )
          .run([artistTwoId]).lastInsertRowid,
      );
      connection
        .prepare(
          "INSERT INTO artist_alias (artist_id, display_alias, normalized_alias, normalization_version, alias_source, identity_decision_id) VALUES (?, 'Artist One', 'artist one', ?, 'manual', ?)",
        )
        .run([artistTwoId, MATCH_TEXT_NORMALIZATION_VERSION, decisionId]);

      sourceRecord(connection, 3, "Artist One", "Manual Alias Song", null, null);
      assert.deepEqual(resolveSourceIdentities(connection, { now: () => 7 }), {
        processed: 1,
        resolved: 1,
        conflicts: 0,
      });
      assert.deepEqual(
        connection
          .prepare(
            "SELECT DISTINCT resolution_rule_version FROM source_identity_resolution ORDER BY resolution_rule_version",
          )
          .all(),
        [{ resolution_rule_version: IDENTITY_RESOLUTION_RULE_VERSION }],
      );
      assert.deepEqual(
        connection
          .prepare(
            `SELECT artist.preferred_name AS artist, resolution.resolution_kind AS kind FROM source_identity_resolution AS resolution JOIN artist ON artist.id = resolution.artist_id WHERE resolution.source_record_id = 3`,
          )
          .all(),
        [{ artist: "Artist Two", kind: "manual_decision" }],
      );
    });
  });

  it("rolls back every resolution write when a later source row fails", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      sourceRecord(connection, 1, "First Artist", "First Song", null, "recording-one");
      sourceRecord(connection, 2, "Second Artist", "Second Song", null, "recording-two");

      connection
        .prepare(
          "INSERT INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (99, 'artist', 1)",
        )
        .run();
      connection
        .prepare(
          "INSERT INTO music_identifier (entity_id, namespace, identifier_value, is_strong) VALUES (99, 'musicbrainz_recording_id', 'recording-two', 1)",
        )
        .run();

      assert.throws(
        () => resolveSourceIdentities(connection, { now: () => 5 }),
        /Resolved track is missing its artist/,
      );
      assert.deepEqual(
        connection
          .prepare(
            `SELECT
               (SELECT count(*) FROM music_entity) AS music_entities,
               (SELECT count(*) FROM artist_alias) AS artist_aliases,
               (SELECT count(*) FROM track) AS tracks,
               (SELECT count(*) FROM track_alias) AS track_aliases,
               (SELECT count(*) FROM music_identifier) AS identifiers,
               (SELECT count(*) FROM source_identity_resolution) AS resolutions,
               (SELECT count(*) FROM identity_resolution_conflict) AS conflicts`,
          )
          .all(),
        [
          {
            music_entities: 1,
            artist_aliases: 0,
            tracks: 0,
            track_aliases: 0,
            identifiers: 1,
            resolutions: 0,
            conflicts: 0,
          },
        ],
      );
    });
  });
});
