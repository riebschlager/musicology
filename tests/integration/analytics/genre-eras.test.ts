import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { generateGenreEraAnalysis } from "../../../src/analytics/genre-eras.ts";
import type { SqliteConnection, SqliteRow, TransactionMode } from "../../../src/db/connection.ts";
import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import { importGenreTaxonomy } from "../../../src/genre/taxonomy-persistence.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

function artistId(name: string): number {
  return [...name].reduce((sum, char) => sum * 31 + (char.codePointAt(0) ?? 0), 0) + 1;
}
function insertPlay(connection: SqliteConnection, name: string, month: number, id: number): void {
  const artist = artistId(name),
    track = id * 10 + 2,
    source = id * 100 + 1,
    at = Date.parse(`2024-${String(month).padStart(2, "0")}-01T18:00:00.000Z`);
  connection
    .prepare(
      "INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '11')",
    )
    .run();
  connection
    .prepare(
      "INSERT OR IGNORE INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (?, 'artist', 1)",
    )
    .run([artist]);
  connection
    .prepare(
      "INSERT INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (?, 'track', 1)",
    )
    .run([track]);
  connection
    .prepare("INSERT OR IGNORE INTO artist (id, preferred_name) VALUES (?, ?)")
    .run([artist, name]);
  connection
    .prepare("INSERT INTO track (id, artist_id, preferred_title) VALUES (?, ?, 'Synthetic Track')")
    .run([track, artist]);
  connection
    .prepare(
      "INSERT INTO listening_event (id, track_id, started_at_epoch_ms, ended_at_epoch_ms, time_basis, event_status, reconciliation_rule_version) VALUES (?, ?, ?, ?, 'observed_start', 'current', 'synthetic-v1')",
    )
    .run([id, track, at, at]);
  connection
    .prepare(
      "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'lastfm', 1, 1)",
    )
    .run([source]);
  connection
    .prepare(
      "INSERT INTO lastfm_scrobble_source (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name, source_fingerprint_sha256) VALUES (?, 'export', 1, 'Synthetic Artist', 'Synthetic Track', ?)",
    )
    .run([source, String(source).padStart(64, "0")]);
  connection
    .prepare(
      "INSERT INTO lastfm_scrobble_occurrence (source_record_id, lastfm_scrobble_source_record_id, source_origin) VALUES (?, ?, 'export')",
    )
    .run([source, source]);
  connection
    .prepare(
      "INSERT INTO listening_event_source (listening_event_id, source_record_id, evidence_role) VALUES (?, ?, 'primary')",
    )
    .run([id, source]);
}
function addSnapshot(
  connection: SqliteConnection,
  name: string,
  tags: readonly { readonly tag: string; readonly weight: number }[],
): void {
  const artist = artistId(name),
    provider = `c0ffee00-cafe-4000-8000-${String(artist).padStart(12, "0")}`;
  connection
    .prepare(
      "INSERT INTO music_identifier (entity_id, namespace, identifier_value, is_strong) VALUES (?, 'musicbrainz_artist_id', ?, 1)",
    )
    .run([artist, provider]);
  const snapshot = Number(
    connection
      .prepare(
        "INSERT INTO genre_enrichment_snapshot (artist_id, provider, provider_entity_id, provider_response_schema_version, contract_version, provider_license, provider_attribution, fetched_at_epoch_ms, cache_state, outcome) VALUES (?, 'musicbrainz', ?, 'musicbrainz-artist-v1', 'genre-evidence-v1', 'CC0 / CC BY-NC-SA', 'MusicBrainz', 0, 'success', 'success')",
      )
      .run([artist, provider]).lastInsertRowid,
  );
  for (const item of tags)
    connection
      .prepare(
        "INSERT INTO genre_enrichment_raw_tag (snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre) VALUES (?, ?, ?, ?, NULL, 1)",
      )
      .run([snapshot, item.tag, item.tag, item.weight]);
}
function plays(
  connection: SqliteConnection,
  name: string,
  month: number,
  first: number,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) insertPlay(connection, name, month, first + index);
}

function observeReadTransaction(connection: SqliteConnection): {
  readonly connection: SqliteConnection;
  readonly readQueriesOutsideTransaction: () => number;
  readonly transactionCount: () => number;
} {
  let depth = 0;
  let readQueriesOutsideTransaction = 0;
  let transactionCount = 0;
  const observed: SqliteConnection = {
    get databasePath() {
      return connection.databasePath;
    },
    get isInTransaction() {
      return depth > 0 || connection.isInTransaction;
    },
    get isOpen() {
      return connection.isOpen;
    },
    checkIntegrity() {
      return connection.checkIntegrity();
    },
    close() {
      connection.close();
    },
    execute(sql) {
      connection.execute(sql);
    },
    prepare<Row extends SqliteRow = SqliteRow>(sql: string) {
      if (depth === 0) readQueriesOutsideTransaction += 1;
      return connection.prepare<Row>(sql);
    },
    transaction<T>(
      operation: (transactionConnection: SqliteConnection) => T,
      mode: TransactionMode | undefined,
    ) {
      transactionCount += 1;
      return connection.transaction(() => {
        depth += 1;
        try {
          return operation(observed);
        } finally {
          depth -= 1;
        }
      }, mode);
    },
  };
  return {
    connection: observed,
    readQueriesOutsideTransaction: () => readQueriesOutsideTransaction,
    transactionCount: () => transactionCount,
  };
}

const parameters = {
  maximumRank: 10,
  minimumConsecutiveActiveWindows: 2,
  minimumEarlierBaselineChange: -100,
  minimumListeningShare: 0.05,
  minimumRollingContribution: 2,
  minimumWindowContribution: 1,
  rollingWindowCount: 2,
  windowSizeMonths: 1,
};

describe("P5-07 genre-era analysis", () => {
  it("reads contributions and canonical calendar events in one transaction", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      plays(connection, "Probe", 1, 1, 1);
      addSnapshot(connection, "Probe", [{ tag: "ambient", weight: 1 }]);
      const observed = observeReadTransaction(connection);

      generateGenreEraAnalysis({
        connection: observed.connection,
        mode: "raw",
        now: () => 1_000,
        parameters,
        presentationTimezone: "America/Chicago",
      });

      assert.equal(observed.transactionCount(), 1);
      assert.equal(observed.readQueriesOutsideTransaction(), 0);
    });
  });

  it("finds overlapping rising and fading fractional genre intervals and visibly qualifies sparse coverage", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      plays(connection, "Rising", 1, 1, 1);
      plays(connection, "Rising", 2, 10, 3);
      plays(connection, "Rising", 3, 20, 4);
      plays(connection, "Fading", 1, 30, 4);
      plays(connection, "Fading", 2, 40, 3);
      plays(connection, "Fading", 3, 50, 1);
      plays(connection, "Unenriched", 1, 60, 4);
      addSnapshot(connection, "Rising", [
        { tag: "electronic", weight: 1 },
        { tag: "pop", weight: 1 },
      ]);
      addSnapshot(connection, "Fading", [{ tag: "rock", weight: 1 }]);
      const result = generateGenreEraAnalysis({
        connection,
        mode: "raw",
        now: () => 1_000,
        parameters,
        presentationTimezone: "America/Chicago",
      });
      assert.deepEqual(
        result.result.intervals.map((item) => item.genreId),
        ["rock", "electronic", "pop"],
      );
      assert.equal(
        result.result.intervals.find((item) => item.genreId === "electronic")?.contribution,
        2,
      );
      assert.equal(
        result.result.intervals.find((item) => item.genreId === "rock")?.peak.windowStart,
        "2024-02",
      );
      assert.deepEqual(result.metadataCoverage.usableGenre, {
        availableEventCount: 16,
        rate: 16 / 20,
        totalEventCount: 20,
      });
      assert.deepEqual(result.result.coverage, {
        missing: { artistCount: 1, eventCount: 4 },
        total: { artistCount: 3, eventCount: 20 },
        usable: { artistCount: 2, eventCount: 16 },
      });
      assert.equal(result.result.mode, "raw");
      assert.equal(result.result.taxonomyVersion, null);
      assert.equal(result.result.weightingLevel, "artist");
    });
  });

  it("keeps taxonomy versions distinct and returns no intervals for sparse usable contribution", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      plays(connection, "Sparse", 1, 1, 1);
      plays(connection, "Missing", 2, 10, 1);
      addSnapshot(connection, "Sparse", [{ tag: "ambient", weight: 1 }]);
      importGenreTaxonomy(
        connection,
        {
          artifactVersion: "genre-taxonomy-v1",
          taxonomyVersion: "taxonomy-v1",
          categories: [{ id: "ambient-v1", label: "Ambient v1", parentId: null }],
          mappings: [{ sourceTag: "ambient", action: "rename", targetCategoryId: "ambient-v1" }],
        },
        1,
      );
      importGenreTaxonomy(
        connection,
        {
          artifactVersion: "genre-taxonomy-v1",
          taxonomyVersion: "taxonomy-v2",
          categories: [{ id: "ambient-v2", label: "Ambient v2", parentId: null }],
          mappings: [{ sourceTag: "ambient", action: "rename", targetCategoryId: "ambient-v2" }],
        },
        2,
      );
      const result = generateGenreEraAnalysis({
        connection,
        mode: "curated",
        parameters,
        presentationTimezone: "America/Chicago",
        taxonomyVersion: "taxonomy-v1",
      });
      const changedTaxonomy = generateGenreEraAnalysis({
        connection,
        mode: "curated",
        parameters,
        presentationTimezone: "America/Chicago",
        taxonomyVersion: "taxonomy-v2",
      });
      assert.deepEqual(result.result.intervals, []);
      assert.equal(result.result.taxonomyVersion, "taxonomy-v1");
      assert.equal(changedTaxonomy.result.taxonomyVersion, "taxonomy-v2");
      assert.equal(
        (changedTaxonomy.result.coverage as { readonly usable: { readonly eventCount: number } })
          .usable.eventCount,
        1,
      );
      assert.equal(result.metadataCoverage.usableGenre?.rate, 0.5);
    });
  });
});
