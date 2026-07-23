import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { openSqliteConnection } from "../../../src/db/better-sqlite3.ts";
import { applyMigrations } from "../../../src/db/migrations.ts";
import type {
  PreparedStatement,
  SqliteConnection,
  SqliteRow,
  TransactionMode,
} from "../../../src/db/connection.ts";
import { createTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import { generateGenreContributions } from "../../../src/genre/contributions.ts";
import { importGenreTaxonomy } from "../../../src/genre/taxonomy-persistence.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

function addArtist(connection: SqliteConnection, name: string, eventCount: number): number {
  const artistId = Number(
    connection
      .prepare("INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('artist', 0)")
      .run().lastInsertRowid,
  );
  connection.prepare("INSERT INTO artist (id, preferred_name) VALUES (?, ?)").run([artistId, name]);
  const trackId = Number(
    connection
      .prepare("INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('track', 0)")
      .run().lastInsertRowid,
  );
  connection
    .prepare("INSERT INTO track (id, artist_id, preferred_title) VALUES (?, ?, 'Synthetic Track')")
    .run([trackId, artistId]);
  connection
    .prepare(
      "INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 0, 'running', '11')",
    )
    .run();
  for (let index = 0; index < eventCount; index += 1) {
    const eventId = Number(
      connection
        .prepare(
          "INSERT INTO listening_event (track_id, started_at_epoch_ms, ended_at_epoch_ms, time_basis, event_status, reconciliation_rule_version) VALUES (?, ?, ?, 'observed_start', 'current', 'synthetic-v1')",
        )
        .run([trackId, index, index]).lastInsertRowid,
    );
    const sourceRecordId = Number(
      connection
        .prepare(
          "INSERT INTO source_record (source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES ('lastfm', 1, 0)",
        )
        .run().lastInsertRowid,
    );
    const fingerprint = `${sourceRecordId}`.padStart(64, "0");
    connection
      .prepare(
        "INSERT INTO lastfm_scrobble_source (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name, source_fingerprint_sha256) VALUES (?, 'export', 0, 'Synthetic Artist', 'Synthetic Track', ?)",
      )
      .run([sourceRecordId, fingerprint]);
    connection
      .prepare(
        "INSERT INTO lastfm_scrobble_occurrence (source_record_id, lastfm_scrobble_source_record_id, source_origin) VALUES (?, ?, 'export')",
      )
      .run([sourceRecordId, sourceRecordId]);
    connection
      .prepare(
        "INSERT INTO listening_event_source (listening_event_id, source_record_id, evidence_role) VALUES (?, ?, 'primary')",
      )
      .run([eventId, sourceRecordId]);
  }
  return artistId;
}

function addSnapshot(
  connection: SqliteConnection,
  artistId: number,
  suffix: string,
  fetchedAt: number,
  tags: readonly { readonly name: string; readonly weight: number }[],
): string {
  const providerId = `c0ffee00-cafe-4000-8000-${suffix.padStart(12, "0")}`;
  connection
    .prepare(
      "INSERT INTO music_identifier (entity_id, namespace, identifier_value, is_strong) VALUES (?, 'musicbrainz_artist_id', ?, 1)",
    )
    .run([artistId, providerId]);
  const snapshotId = Number(
    connection
      .prepare(
        "INSERT INTO genre_enrichment_snapshot (artist_id, provider, provider_entity_id, provider_response_schema_version, contract_version, provider_license, provider_attribution, fetched_at_epoch_ms, cache_state, outcome) VALUES (?, 'musicbrainz', ?, 'musicbrainz-artist-v1', 'genre-evidence-v1', 'CC0 / CC BY-NC-SA', 'MusicBrainz', ?, 'success', 'success')",
      )
      .run([artistId, providerId, fetchedAt]).lastInsertRowid,
  );
  for (const tag of tags)
    connection
      .prepare(
        "INSERT INTO genre_enrichment_raw_tag (snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre) VALUES (?, ?, ?, ?, NULL, 1)",
      )
      .run([snapshotId, tag.name, tag.name, tag.weight]);
  return providerId;
}

describe("P5-06 genre contributions", () => {
  it("normalizes multi-tag artist evidence per event with deterministic residual rounding", () => {
    const database = createTemporarySqliteDatabase();
    try {
      applyMigrations(database.connection, migrationsDirectory);
      const artistId = addArtist(database.connection, "Weighted", 2);
      addSnapshot(database.connection, artistId, "1", 900, [
        { name: "alpha", weight: 1 },
        { name: "beta", weight: 1 },
        { name: "gamma", weight: 1 },
      ]);
      const result = generateGenreContributions({
        connection: database.connection,
        mode: "raw",
        now: () => 1_000,
        presentationTimezone: "America/Chicago",
      });
      assert.deepEqual(result.eventContributions[0]?.contributions, [
        { contribution: 0.333333333333, genreId: "alpha", genreLabel: "alpha" },
        { contribution: 0.333333333333, genreId: "beta", genreLabel: "beta" },
        { contribution: 0.333333333334, genreId: "gamma", genreLabel: "gamma" },
      ]);
      assert.equal(
        result.eventContributions.every(
          (event) => event.contributions.reduce((sum, item) => sum + item.contribution, 0) === 1,
        ),
        true,
      );
      assert.deepEqual(result.coverage, {
        missing: { artistCount: 0, eventCount: 0 },
        total: { artistCount: 1, eventCount: 2 },
        usable: { artistCount: 1, eventCount: 2 },
      });
      assert.deepEqual(result.freshness.fresh, { artistCount: 1, eventCount: 2 });
      assert.equal(result.weightingLevel, "artist");
    } finally {
      database.cleanup();
    }
  });

  it("uses Unicode code-unit genre ordering for locale-independent residual allocation", () => {
    const database = createTemporarySqliteDatabase();
    try {
      applyMigrations(database.connection, migrationsDirectory);
      const artistId = addArtist(database.connection, "Unicode", 1);
      addSnapshot(database.connection, artistId, "unicode", 900, [
        { name: "zeta", weight: 1 },
        { name: "ämbient", weight: 1 },
        { name: "žeta", weight: 1 },
      ]);

      const result = generateGenreContributions({
        connection: database.connection,
        mode: "raw",
        now: () => 1_000,
        presentationTimezone: "America/Chicago",
      });

      assert.deepEqual(result.eventContributions[0]?.contributions, [
        { contribution: 0.333333333333, genreId: "zeta", genreLabel: "zeta" },
        { contribution: 0.333333333333, genreId: "ämbient", genreLabel: "ämbient" },
        { contribution: 0.333333333334, genreId: "žeta", genreLabel: "žeta" },
      ]);
      assert.deepEqual(
        result.aggregates.map((aggregate) => aggregate.genreId),
        ["zeta", "ämbient", "žeta"],
      );
    } finally {
      database.cleanup();
    }
  });

  it("reads snapshots, evidence, and canonical events from one deferred transaction", () => {
    const database = createTemporarySqliteDatabase();
    const concurrentConnection = openSqliteConnection(database.databasePath);
    try {
      applyMigrations(database.connection, migrationsDirectory);
      const artistId = addArtist(database.connection, "Snapshot", 1);
      const providerId = addSnapshot(database.connection, artistId, "snapshot", 100, [
        { name: "earlier", weight: 1 },
      ]);
      let refreshedAfterFirstRead = false;
      const transactionModes: (TransactionMode | undefined)[] = [];
      let hookedConnection: SqliteConnection;
      hookedConnection = {
        get databasePath(): string {
          return database.connection.databasePath;
        },
        get isOpen(): boolean {
          return database.connection.isOpen;
        },
        get isInTransaction(): boolean {
          return database.connection.isInTransaction;
        },
        execute(sql: string): void {
          database.connection.execute(sql);
        },
        prepare<Row extends SqliteRow = SqliteRow>(sql: string): PreparedStatement<Row> {
          const statement = database.connection.prepare<Row>(sql);
          if (
            refreshedAfterFirstRead ||
            !sql.includes("SELECT snapshot_id, artist_id, fetched_at_epoch_ms, cache_state")
          ) {
            return statement;
          }
          return {
            run: (parameters) => statement.run(parameters),
            get: (parameters) => statement.get(parameters),
            all: (parameters) => {
              const rows = statement.all(parameters);
              refreshedAfterFirstRead = true;
              const snapshotId = Number(
                concurrentConnection
                  .prepare(
                    "INSERT INTO genre_enrichment_snapshot (artist_id, provider, provider_entity_id, provider_response_schema_version, contract_version, provider_license, provider_attribution, fetched_at_epoch_ms, cache_state, outcome) VALUES (?, 'musicbrainz', ?, 'musicbrainz-artist-v1', 'genre-evidence-v1', 'CC0 / CC BY-NC-SA', 'MusicBrainz', 900, 'success', 'success')",
                  )
                  .run([artistId, providerId]).lastInsertRowid,
              );
              concurrentConnection
                .prepare(
                  "INSERT INTO genre_enrichment_raw_tag (snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre) VALUES (?, 'later', 'later', 1, NULL, 1)",
                )
                .run([snapshotId]);
              return rows;
            },
            iterate: (parameters) => statement.iterate(parameters),
          };
        },
        transaction<T>(operation: (connection: SqliteConnection) => T, mode?: TransactionMode): T {
          transactionModes.push(mode);
          return database.connection.transaction(() => operation(hookedConnection), mode);
        },
        checkIntegrity() {
          return database.connection.checkIntegrity();
        },
        close(): void {
          database.connection.close();
        },
      };

      const result = generateGenreContributions({
        connection: hookedConnection,
        mode: "raw",
        now: () => 1_000,
        presentationTimezone: "America/Chicago",
        refreshAgeMs: 500,
      });

      assert.deepEqual(transactionModes, ["deferred"]);
      assert.equal(refreshedAfterFirstRead, true);
      assert.deepEqual(result.eventContributions[0]?.contributions, [
        { contribution: 1, genreId: "earlier", genreLabel: "earlier" },
      ]);
      assert.deepEqual(result.freshness.stale, { artistCount: 1, eventCount: 1 });
    } finally {
      concurrentConnection.close();
      database.cleanup();
    }
  });

  it("keeps unenriched and unmapped events missing while preserving curated taxonomy and freshness metadata", () => {
    const database = createTemporarySqliteDatabase();
    try {
      applyMigrations(database.connection, migrationsDirectory);
      const mapped = addArtist(database.connection, "Mapped", 1);
      const unmapped = addArtist(database.connection, "Unmapped", 1);
      addArtist(database.connection, "Missing", 1);
      addSnapshot(database.connection, mapped, "2", 0, [
        { name: "dream pop", weight: 2 },
        { name: "ignored", weight: 1 },
      ]);
      addSnapshot(database.connection, unmapped, "3", 0, [{ name: "unmapped", weight: 1 }]);
      importGenreTaxonomy(
        database.connection,
        {
          artifactVersion: "genre-taxonomy-v1",
          taxonomyVersion: "synthetic-v1",
          categories: [{ id: "dream-pop", label: "Dream Pop", parentId: null }],
          mappings: [
            { sourceTag: "dream pop", action: "rename", targetCategoryId: "dream-pop" },
            { sourceTag: "ignored", action: "ignore", targetCategoryId: null },
          ],
        },
        1,
      );
      const result = generateGenreContributions({
        connection: database.connection,
        mode: "curated",
        now: () => 1_000,
        presentationTimezone: "America/Chicago",
        refreshAgeMs: 500,
        taxonomyVersion: "synthetic-v1",
      });
      assert.deepEqual(result.aggregates, [
        { contribution: 1, eventCount: 1, genreId: "dream-pop", genreLabel: "Dream Pop" },
      ]);
      assert.deepEqual(result.coverage, {
        missing: { artistCount: 2, eventCount: 2 },
        total: { artistCount: 3, eventCount: 3 },
        usable: { artistCount: 1, eventCount: 1 },
      });
      assert.deepEqual(result.freshness, {
        evaluatedAtEpochMs: 1_000,
        fresh: { artistCount: 0, eventCount: 0 },
        refreshAgeMs: 500,
        stale: { artistCount: 1, eventCount: 1 },
      });
      assert.equal(result.taxonomyVersion, "synthetic-v1");
      assert.equal(result.provider, "musicbrainz");
      assert.throws(
        () =>
          generateGenreContributions({
            connection: database.connection,
            mode: "curated",
            presentationTimezone: "America/Chicago",
          }),
        /require a taxonomy version/u,
      );
      assert.equal(database.connection.checkIntegrity().ok, true);
    } finally {
      database.cleanup();
    }
  });

  it("does not reuse older successful tags after a newer negative provider snapshot", () => {
    const database = createTemporarySqliteDatabase();
    try {
      applyMigrations(database.connection, migrationsDirectory);
      const artistId = addArtist(database.connection, "Refreshed Missing", 1);
      const providerId = addSnapshot(database.connection, artistId, "4", 100, [
        { name: "older-tag", weight: 1 },
      ]);
      database.connection
        .prepare(
          "INSERT INTO genre_enrichment_snapshot (artist_id, provider, provider_entity_id, provider_response_schema_version, contract_version, provider_license, provider_attribution, fetched_at_epoch_ms, cache_state, outcome) VALUES (?, 'musicbrainz', ?, 'musicbrainz-artist-v1', 'genre-evidence-v1', 'CC0 / CC BY-NC-SA', 'MusicBrainz', 200, 'negative', 'no_tags')",
        )
        .run([artistId, providerId]);
      const result = generateGenreContributions({
        connection: database.connection,
        mode: "raw",
        presentationTimezone: "America/Chicago",
      });
      assert.deepEqual(result.eventContributions, []);
      assert.deepEqual(result.coverage, {
        missing: { artistCount: 1, eventCount: 1 },
        total: { artistCount: 1, eventCount: 1 },
        usable: { artistCount: 0, eventCount: 0 },
      });
    } finally {
      database.cleanup();
    }
  });
});
