import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { SqliteConnection, SqliteRow } from "../../../src/db/connection.ts";
import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

interface SchemaObjectRow extends SqliteRow {
  readonly name: string;
  readonly sql: string | null;
  readonly type: "index" | "table";
}

interface TableInfoRow extends SqliteRow {
  readonly name: string;
}

interface ForeignKeyRow extends SqliteRow {
  readonly from: string;
  readonly table: string;
}

function schemaObjects(connection: SqliteConnection): readonly SchemaObjectRow[] {
  return connection
    .prepare<SchemaObjectRow>(
      `SELECT type, name, sql
       FROM sqlite_schema
       WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();
}

function columns(connection: SqliteConnection, table: string): readonly string[] {
  return connection
    .prepare<TableInfoRow>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

function foreignKeys(connection: SqliteConnection, table: string): readonly string[] {
  return connection
    .prepare<ForeignKeyRow>(`PRAGMA foreign_key_list(${table})`)
    .all()
    .map((row) => `${row.from}->${row.table}`)
    .sort();
}

describe("initial schema contract", () => {
  it("creates every planned data layer with the required columns", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);

      const tables = schemaObjects(connection)
        .filter((object) => object.type === "table")
        .map((object) => object.name);
      assert.deepEqual(tables, [
        "artist",
        "artist_alias",
        "artist_genre_evidence",
        "genre_mapping",
        "genre_tag",
        "identity_decision",
        "ingest_run",
        "lastfm_scrobble_source",
        "listening_event",
        "listening_event_source",
        "music_entity",
        "music_identifier",
        "reconciliation_candidate",
        "rejected_source_record",
        "release",
        "schema_migration",
        "source_file",
        "source_record",
        "spotify_play_source",
        "sync_cursor",
        "track",
      ]);

      assert.deepEqual(columns(connection, "spotify_play_source"), [
        "source_record_id",
        "stopped_at_epoch_ms",
        "ms_played",
        "spotify_track_uri",
        "artist_name",
        "album_name",
        "track_name",
        "reason_start",
        "reason_end",
        "shuffle",
        "skipped",
        "offline",
        "offline_at_epoch_ms",
        "source_fingerprint_sha256",
      ]);
      assert.deepEqual(columns(connection, "lastfm_scrobble_source"), [
        "source_record_id",
        "source_origin",
        "api_scrobble_id",
        "scrobbled_at_epoch_ms",
        "artist_name",
        "album_name",
        "track_name",
        "artist_musicbrainz_id",
        "release_musicbrainz_id",
        "recording_musicbrainz_id",
        "loved",
        "source_fingerprint_sha256",
      ]);
      assert.deepEqual(columns(connection, "listening_event"), [
        "id",
        "track_id",
        "started_at_epoch_ms",
        "ended_at_epoch_ms",
        "listened_ms",
        "time_basis",
        "event_status",
        "reconciliation_rule_version",
        "superseded_by_event_id",
      ]);
      assert.deepEqual(columns(connection, "rejected_source_record"), [
        "id",
        "ingest_run_id",
        "source_file_id",
        "source_ordinal",
        "source_kind",
        "error_code",
        "safe_diagnostic_summary",
        "rejected_at_epoch_ms",
      ]);
    });
  });

  it("provides named indexes for import, reconciliation, and analytical access paths", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const indexes = new Set(
        schemaObjects(connection)
          .filter((object) => object.type === "index")
          .map((object) => object.name),
      );
      for (const expected of [
        "source_record_source_file_idx",
        "spotify_play_source_fingerprint_idx",
        "spotify_play_source_track_time_idx",
        "lastfm_scrobble_source_artist_track_time_idx",
        "artist_alias_normalized_idx",
        "track_artist_title_idx",
        "listening_event_track_time_idx",
        "reconciliation_candidate_state_idx",
        "artist_genre_evidence_artist_idx",
      ]) {
        assert.equal(indexes.has(expected), true, `missing index ${expected}`);
      }
    });
  });

  it("enforces provenance foreign keys, uniqueness, and enumerated checks", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);

      assert.deepEqual(foreignKeys(connection, "spotify_play_source"), [
        "source_record_id->source_record",
      ]);
      assert.deepEqual(foreignKeys(connection, "listening_event_source"), [
        "listening_event_id->listening_event",
        "reconciliation_candidate_id->reconciliation_candidate",
        "source_record_id->source_record",
      ]);
      assert.deepEqual(foreignKeys(connection, "artist_genre_evidence"), [
        "artist_id->artist",
        "genre_tag_id->genre_tag",
      ]);

      assert.throws(
        () =>
          connection
            .prepare(
              `INSERT INTO ingest_run
                (command_type, started_at_epoch_ms, status, schema_version)
               VALUES ('unknown', 1, 'running', '1')`,
            )
            .run(),
        /CHECK constraint failed/,
      );
      assert.throws(
        () =>
          connection
            .prepare(
              `INSERT INTO spotify_play_source
                (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri,
                 artist_name, track_name, shuffle, source_fingerprint_sha256)
               VALUES (999, 1, 1, 'spotify:track:test', 'Artist', 'Track', 0,
                 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
            )
            .run(),
        /FOREIGN KEY constraint failed/,
      );

      const tableSql = schemaObjects(connection)
        .filter((object) => object.type === "table")
        .map((object) => object.sql ?? "")
        .join("\n");
      assert.match(
        tableSql,
        /UNIQUE \(spotify_source_record_id, lastfm_source_record_id, rule_version\)/,
      );
      assert.match(tableSql, /total_confidence BETWEEN 0\.0 AND 1\.0/);
      assert.match(tableSql, /source_origin IN \('export', 'api'\)/);
    });
  });

  it("contains no excluded or raw-payload fields anywhere in the schema", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const identifiers = schemaObjects(connection)
        .flatMap((object) => [object.name, ...columns(connection, object.name)])
        .map((identifier) => identifier.toLowerCase());

      for (const forbidden of [
        "ip_address",
        "username",
        "user_agent",
        "country",
        "platform",
        "api_key",
        "raw_payload",
      ]) {
        assert.equal(
          identifiers.some((identifier) => identifier.includes(forbidden)),
          false,
          `excluded schema identifier contains ${forbidden}`,
        );
      }
    });
  });

  it("reapplies as a no-op and passes SQLite integrity checks", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      const first = applyMigrations(connection, migrationsDirectory);
      assert.deepEqual(
        first.appliedNow.map((migration) => migration.name),
        ["create_initial_schema"],
      );
      assert.deepEqual(applyMigrations(connection, migrationsDirectory).appliedNow, []);
      assert.deepEqual(connection.checkIntegrity(), {
        ok: true,
        messages: ["ok"],
        foreignKeyViolations: [],
      });
    });
  });
});
