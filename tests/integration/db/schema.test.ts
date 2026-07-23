import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  it("backfills occurrence provenance and preserves existing file relationships", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      for (const migration of [
        "0001_create_initial_schema.sql",
        "0002_add_ingest_lifecycle_counts.sql",
      ]) {
        connection.execute(readFileSync(`${migrationsDirectory}/${migration}`, "utf8"));
      }
      const run = connection
        .prepare(
          `INSERT INTO ingest_run
            (command_type, started_at_epoch_ms, status, schema_version)
           VALUES ('lastfm_export_import', 1, 'running', '2')`,
        )
        .run();
      const sourceFile = connection
        .prepare(
          `INSERT INTO source_file
            (relative_path, source_type, byte_size, content_sha256,
             first_ingest_run_id, last_ingest_run_id)
           VALUES ('lastfm/legacy.json', 'lastfm_export', 2,
                   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                   @runId, @runId)`,
        )
        .run({ runId: Number(run.lastInsertRowid) });
      const sourceRecord = connection
        .prepare(
          `INSERT INTO source_record
            (source_kind, ingest_run_id, source_file_id, source_ordinal, accepted_at_epoch_ms)
           VALUES ('lastfm', @runId, @sourceFileId, 0, 1)`,
        )
        .run({
          runId: Number(run.lastInsertRowid),
          sourceFileId: Number(sourceFile.lastInsertRowid),
        });
      connection
        .prepare(
          `INSERT INTO lastfm_scrobble_source
            (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name,
             source_fingerprint_sha256)
           VALUES (@sourceRecordId, 'export', 1, 'Synthetic Artist', 'Synthetic Track',
                   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`,
        )
        .run({ sourceRecordId: Number(sourceRecord.lastInsertRowid) });
      const rejectedRecord = connection
        .prepare(
          `INSERT INTO rejected_source_record
            (ingest_run_id, source_file_id, source_ordinal, source_kind, error_code,
             safe_diagnostic_summary, rejected_at_epoch_ms)
           VALUES (@runId, @sourceFileId, 1, 'lastfm', 'invalid_timestamp', 'Safe summary', 1)`,
        )
        .run({
          runId: Number(run.lastInsertRowid),
          sourceFileId: Number(sourceFile.lastInsertRowid),
        });

      connection.transaction((transactionConnection) => {
        for (const migration of [
          "0003_add_lastfm_occurrence_provenance.sql",
          "0004_scope_source_file_hash_by_type.sql",
        ]) {
          transactionConnection.execute(
            readFileSync(`${migrationsDirectory}/${migration}`, "utf8"),
          );
        }
      });

      assert.deepEqual(
        connection
          .prepare(
            `SELECT source_record_id, lastfm_scrobble_source_record_id, source_origin
             FROM lastfm_scrobble_occurrence`,
          )
          .get(),
        {
          source_record_id: Number(sourceRecord.lastInsertRowid),
          lastfm_scrobble_source_record_id: Number(sourceRecord.lastInsertRowid),
          source_origin: "export",
        },
      );
      assert.deepEqual(
        connection
          .prepare(
            `SELECT source.source_file_id, source.source_ordinal,
                    rejected.source_file_id AS rejected_source_file_id
             FROM source_record AS source
             JOIN rejected_source_record AS rejected ON rejected.id = @rejectedRecordId
             WHERE source.id = @sourceRecordId`,
          )
          .get({
            rejectedRecordId: Number(rejectedRecord.lastInsertRowid),
            sourceRecordId: Number(sourceRecord.lastInsertRowid),
          }),
        {
          source_file_id: Number(sourceFile.lastInsertRowid),
          source_ordinal: 0,
          rejected_source_file_id: Number(sourceFile.lastInsertRowid),
        },
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

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
        "cross_source_candidate_generation",
        "genre_enrichment_raw_tag",
        "genre_enrichment_snapshot",
        "genre_mapping",
        "genre_tag",
        "identity_decision",
        "identity_resolution_conflict",
        "ingest_run",
        "lastfm_api_sync_metadata",
        "lastfm_scrobble_occurrence",
        "lastfm_scrobble_source",
        "listening_event",
        "listening_event_source",
        "manual_decision_artifact",
        "manual_identity_decision",
        "manual_identity_resolution_override",
        "manual_identity_track_override",
        "manual_reconciliation_decision",
        "music_entity",
        "music_identifier",
        "reconciliation_candidate",
        "reconciliation_decision",
        "rejected_source_record",
        "release",
        "release_alias",
        "schema_migration",
        "source_file",
        "source_identity_resolution",
        "source_record",
        "spotify_play_source",
        "sync_cursor",
        "track",
        "track_alias",
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
      assert.deepEqual(columns(connection, "lastfm_scrobble_occurrence"), [
        "source_record_id",
        "lastfm_scrobble_source_record_id",
        "source_origin",
      ]);
      assert.deepEqual(columns(connection, "lastfm_api_sync_metadata"), [
        "ingest_run_id",
        "page_count",
        "completed_track_count",
        "ignored_now_playing_count",
      ]);
      assert.deepEqual(columns(connection, "source_identity_resolution"), [
        "source_record_id",
        "artist_id",
        "release_id",
        "track_id",
        "resolution_kind",
        "resolution_rule_version",
        "normalization_version",
        "resolved_at_epoch_ms",
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
      assert.deepEqual(columns(connection, "ingest_run"), [
        "id",
        "command_type",
        "started_at_epoch_ms",
        "completed_at_epoch_ms",
        "status",
        "schema_version",
        "rule_version",
        "discovered_count",
        "accepted_count",
        "rejected_count",
        "unsupported_count",
        "safe_error_summary",
        "discovered_file_count",
        "registered_file_count",
        "noop_file_count",
        "duplicated_count",
        "excluded_count",
      ]);
      assert.deepEqual(columns(connection, "reconciliation_candidate"), [
        "id",
        "spotify_source_record_id",
        "lastfm_source_record_id",
        "identifier_agreement",
        "artist_score",
        "track_score",
        "album_score",
        "start_delta_ms",
        "duration_score",
        "ordering_score",
        "ambiguity_score",
        "total_confidence",
        "rule_version",
        "candidate_state",
        "resolved_at_epoch_ms",
        "resolution_rationale",
        "supersedes_candidate_id",
        "short_play_score",
        "competing_candidate_score",
      ]);
      assert.deepEqual(columns(connection, "reconciliation_decision"), [
        "id",
        "reconciliation_candidate_id",
        "policy_rule_version",
        "decision",
        "applied_at_epoch_ms",
        "decision_state",
        "source_listening_event_id",
        "target_listening_event_id",
        "source_event_status",
        "superseded_by_decision_id",
        "rationale",
      ]);
      assert.deepEqual(columns(connection, "manual_decision_artifact"), [
        "decision_key",
        "artifact_version",
        "decision_type",
        "payload_json",
        "imported_at_epoch_ms",
      ]);
      assert.deepEqual(columns(connection, "manual_identity_decision"), [
        "decision_key",
        "identity_decision_id",
        "subject_source_record_id",
        "object_source_record_id",
      ]);
      assert.deepEqual(columns(connection, "manual_reconciliation_decision"), [
        "decision_key",
        "reconciliation_candidate_id",
        "decision",
        "source_listening_event_id",
        "target_listening_event_id",
        "source_event_status",
      ]);
      assert.deepEqual(columns(connection, "manual_identity_resolution_override"), [
        "manual_decision_key",
        "source_record_id",
        "artist_id",
        "release_id",
        "track_id",
        "resolution_kind",
        "resolution_rule_version",
        "normalization_version",
        "resolved_at_epoch_ms",
      ]);
      assert.deepEqual(columns(connection, "manual_identity_track_override"), [
        "manual_decision_key",
        "track_id",
        "artist_id",
        "release_id",
      ]);
      assert.deepEqual(columns(connection, "genre_enrichment_snapshot"), [
        "id",
        "artist_id",
        "provider",
        "provider_entity_id",
        "provider_response_schema_version",
        "contract_version",
        "provider_license",
        "provider_attribution",
        "fetched_at_epoch_ms",
        "cache_state",
        "outcome",
        "error_code",
        "supersedes_snapshot_id",
      ]);
      assert.deepEqual(columns(connection, "genre_enrichment_raw_tag"), [
        "id",
        "snapshot_id",
        "raw_tag_name",
        "normalized_raw_tag",
        "raw_weight",
        "confidence",
        "is_recognized_genre",
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
        "spotify_play_source_derived_start_block_idx",
        "lastfm_scrobble_source_artist_track_time_idx",
        "lastfm_scrobble_source_time_block_idx",
        "lastfm_scrobble_occurrence_evidence_idx",
        "artist_alias_normalized_idx",
        "track_artist_title_idx",
        "listening_event_track_time_idx",
        "reconciliation_candidate_state_idx",
        "artist_genre_evidence_artist_idx",
        "genre_enrichment_snapshot_artist_provider_idx",
        "genre_enrichment_raw_tag_snapshot_idx",
        "manual_reconciliation_decision_candidate_idx",
        "manual_identity_resolution_override_source_idx",
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
      assert.deepEqual(foreignKeys(connection, "lastfm_scrobble_occurrence"), [
        "lastfm_scrobble_source_record_id->lastfm_scrobble_source",
        "source_record_id->source_record",
      ]);
      assert.deepEqual(foreignKeys(connection, "lastfm_api_sync_metadata"), [
        "ingest_run_id->ingest_run",
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
      assert.deepEqual(foreignKeys(connection, "genre_enrichment_snapshot"), [
        "artist_id->artist",
        "supersedes_snapshot_id->genre_enrichment_snapshot",
      ]);
      assert.deepEqual(foreignKeys(connection, "genre_enrichment_raw_tag"), [
        "snapshot_id->genre_enrichment_snapshot",
      ]);
      assert.deepEqual(foreignKeys(connection, "manual_identity_decision"), [
        "decision_key->manual_decision_artifact",
        "identity_decision_id->identity_decision",
        "object_source_record_id->source_record",
        "subject_source_record_id->source_record",
      ]);
      assert.deepEqual(foreignKeys(connection, "manual_reconciliation_decision"), [
        "decision_key->manual_decision_artifact",
        "reconciliation_candidate_id->reconciliation_candidate",
        "source_listening_event_id->listening_event",
        "target_listening_event_id->listening_event",
      ]);
      assert.deepEqual(foreignKeys(connection, "manual_identity_resolution_override"), [
        "artist_id->artist",
        "manual_decision_key->manual_decision_artifact",
        "release_id->release",
        "source_record_id->source_record",
        "track_id->track",
      ]);
      assert.deepEqual(foreignKeys(connection, "manual_identity_track_override"), [
        "artist_id->artist",
        "manual_decision_key->manual_decision_artifact",
        "release_id->release",
        "track_id->track",
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

      const historicalRun = connection
        .prepare(
          `INSERT INTO ingest_run (command_type, started_at_epoch_ms, status, schema_version)
           VALUES ('lastfm_export_import', 1, 'running', '11')`,
        )
        .run();
      const apiRun = connection
        .prepare(
          `INSERT INTO ingest_run (command_type, started_at_epoch_ms, status, schema_version)
           VALUES ('lastfm_api_sync', 1, 'running', '11')`,
        )
        .run();
      const insertApiMetadata = connection.prepare(
        `INSERT INTO lastfm_api_sync_metadata
          (ingest_run_id, page_count, completed_track_count, ignored_now_playing_count)
         VALUES (?, 0, 0, 0)`,
      );
      assert.throws(
        () => insertApiMetadata.run([Number(historicalRun.lastInsertRowid)]),
        /Last\.fm API sync metadata requires a lastfm_api_sync ingest run/,
      );
      insertApiMetadata.run([Number(apiRun.lastInsertRowid)]);
      assert.throws(
        () =>
          connection
            .prepare("UPDATE ingest_run SET command_type = 'lastfm_export_import' WHERE id = ?")
            .run([Number(apiRun.lastInsertRowid)]),
        /Last\.fm API sync metadata requires a lastfm_api_sync ingest run/,
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

  it("enforces successful ingest-run count reconciliation", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);

      const insertSucceededRun = connection.prepare(
        `INSERT INTO ingest_run
          (command_type, started_at_epoch_ms, completed_at_epoch_ms, status, schema_version,
           discovered_count, accepted_count, rejected_count, unsupported_count,
           discovered_file_count, registered_file_count, noop_file_count, duplicated_count,
           excluded_count)
         VALUES
          ('spotify_import', 1, 2, 'succeeded', '2',
           @discovered, @accepted, @rejected, @unsupported,
           @discoveredFiles, @registeredFiles, @noopFiles, @duplicated, @excluded)`,
      );
      const validCounts = {
        discovered: 3,
        accepted: 2,
        rejected: 1,
        unsupported: 1,
        discoveredFiles: 2,
        registeredFiles: 1,
        noopFiles: 0,
        duplicated: 1,
        excluded: 0,
      } as const;

      for (const invalidCounts of [
        { ...validCounts, discovered: 4 },
        { ...validCounts, duplicated: 3 },
        { ...validCounts, discoveredFiles: 3 },
      ]) {
        assert.throws(
          () => insertSucceededRun.run(invalidCounts),
          /succeeded ingest_run counts do not reconcile/,
        );
      }

      const inserted = insertSucceededRun.run(validCounts);
      assert.throws(
        () =>
          connection
            .prepare("UPDATE ingest_run SET accepted_count = 1 WHERE id = ?")
            .run([Number(inserted.lastInsertRowid)]),
        /succeeded ingest_run counts do not reconcile/,
      );
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
        [
          "create_initial_schema",
          "add_ingest_lifecycle_counts",
          "add_lastfm_occurrence_provenance",
          "scope_source_file_hash_by_type",
          "add_identity_resolution",
          "add_cross_source_candidate_generation",
          "add_reconciliation_match_features",
          "add_reconciliation_decision_history",
          "add_manual_decision_artifacts",
          "add_manual_identity_override_snapshots",
          "add_lastfm_api_sync_metadata",
          "add_genre_enrichment_evidence_contract",
        ],
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
