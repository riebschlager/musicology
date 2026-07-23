import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANALYTICS_BENCHMARK_VERSION,
  AnalyticalBenchmarkError,
  benchmarkAnalyses,
} from "../../../src/analytics/benchmark.ts";
import { CANONICAL_ANALYTICAL_BASE_SQL } from "../../../src/analytics/base.ts";
import { openSqliteConnection } from "../../../src/db/better-sqlite3.ts";
import type {
  PreparedStatement,
  SqliteConnection,
  SqliteRow,
  TransactionMode,
} from "../../../src/db/connection.ts";
import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import { createCanonicalEvents } from "../../../src/identity/events.ts";
import { resolveSourceIdentities } from "../../../src/identity/resolution.ts";
import { importSpotifyFiles } from "../../../src/importers/spotify/persistence.ts";
import { buildSpotifyTrackFixture } from "../../fixtures/index.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

function seedCanonicalEvents(workspace: TemporaryTestWorkspace): void {
  const fixturePath = workspace.writeJsonFixture("spotify/Streaming_History_Audio_2026_0.json", [
    buildSpotifyTrackFixture(),
    buildSpotifyTrackFixture({
      spotify_track_uri: "spotify:track:0000000000000000000011",
      ts: "2026-01-03T03:04:05.678Z",
    }),
  ]);
  importSpotifyFiles({
    candidatePaths: [fixturePath],
    connection: workspace.connection,
    evidenceRoot: workspace.configuration.paths.inputsDirectory,
    now: () => 1_800_000_000_000,
    schemaVersion: "4",
  });
  resolveSourceIdentities(workspace.connection, { now: () => 1_800_000_001_000 });
  createCanonicalEvents(workspace.connection);
}

describe("analytics benchmark", () => {
  it("runs every analytical family, reconciles its canonical population, and reports safe timings", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      let time = 100;
      const result = benchmarkAnalyses(connection, "America/Chicago", () => {
        time += 5;
        return time;
      });
      assert.equal(result.version, ANALYTICS_BENCHMARK_VERSION);
      assert.equal(result.canonicalEventCount, 0);
      assert.deepEqual(
        result.measurements.map((measurement) => [measurement.operation, measurement.eventCount]),
        [
          ["volume", 0],
          ["artist-eras", 0],
          ["rediscovery", 0],
          ["abandonment", 0],
        ],
      );
      assert.deepEqual(
        result.measurements.map((measurement) => measurement.elapsedMilliseconds),
        [5, 5, 5, 5],
      );
    });
  });

  it("rejects a non-monotonic benchmark clock", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      let callCount = 0;
      assert.throws(
        () =>
          benchmarkAnalyses(connection, "America/Chicago", () => {
            callCount += 1;
            return callCount % 2 === 0 ? 0 : 1;
          }),
        /monotonic/u,
      );
    });
  });

  it("keeps coverage and every analysis on one snapshot during a concurrent reconciliation", () => {
    withTemporaryTestWorkspace((workspace) => {
      seedCanonicalEvents(workspace);
      const concurrentConnection = openSqliteConnection(workspace.configuration.paths.databasePath);
      let changedDuringBenchmark = false;
      const hookedConnection: SqliteConnection = {
        get databasePath(): string {
          return workspace.connection.databasePath;
        },
        get isOpen(): boolean {
          return workspace.connection.isOpen;
        },
        get isInTransaction(): boolean {
          return workspace.connection.isInTransaction;
        },
        execute(sql: string): void {
          workspace.connection.execute(sql);
        },
        prepare<Row extends SqliteRow = SqliteRow>(sql: string): PreparedStatement<Row> {
          if (!changedDuringBenchmark && sql === CANONICAL_ANALYTICAL_BASE_SQL) {
            changedDuringBenchmark = true;
            concurrentConnection
              .prepare(
                `UPDATE listening_event
                 SET event_status = 'superseded',
                     superseded_by_event_id = (SELECT max(id) FROM listening_event)
                 WHERE id = (SELECT min(id) FROM listening_event)`,
              )
              .run();
          }
          return workspace.connection.prepare<Row>(sql);
        },
        transaction<T>(operation: (connection: SqliteConnection) => T, mode?: TransactionMode): T {
          return workspace.connection.transaction(() => operation(hookedConnection), mode);
        },
        checkIntegrity() {
          return workspace.connection.checkIntegrity();
        },
        close(): void {
          workspace.connection.close();
        },
      };

      try {
        const result = benchmarkAnalyses(hookedConnection, "America/Chicago");
        assert.equal(changedDuringBenchmark, true);
        assert.equal(result.canonicalEventCount, 2);
        assert.deepEqual(
          result.measurements.map((measurement) => measurement.eventCount),
          [2, 2, 2, 2],
        );
      } finally {
        concurrentConnection.close();
      }
    });
  });

  it("fails when a populated analytical result does not reconcile to canonical coverage", () => {
    withTemporaryTestWorkspace((workspace) => {
      seedCanonicalEvents(workspace);
      let hookedConnection: SqliteConnection;
      hookedConnection = {
        get databasePath(): string {
          return workspace.connection.databasePath;
        },
        get isOpen(): boolean {
          return workspace.connection.isOpen;
        },
        get isInTransaction(): boolean {
          return workspace.connection.isInTransaction;
        },
        execute(sql: string): void {
          workspace.connection.execute(sql);
        },
        prepare<Row extends SqliteRow = SqliteRow>(sql: string): PreparedStatement<Row> {
          const adjustedSql =
            sql === CANONICAL_ANALYTICAL_BASE_SQL
              ? sql.replace(
                  "WHERE event.event_status IN ('current', 'unresolved')",
                  "WHERE event.event_status = 'unresolved'",
                )
              : sql;
          return workspace.connection.prepare<Row>(adjustedSql);
        },
        transaction<T>(operation: (connection: SqliteConnection) => T, mode?: TransactionMode): T {
          return workspace.connection.transaction(() => operation(hookedConnection), mode);
        },
        checkIntegrity() {
          return workspace.connection.checkIntegrity();
        },
        close(): void {
          workspace.connection.close();
        },
      };

      assert.throws(
        () => benchmarkAnalyses(hookedConnection, "America/Chicago"),
        (error: unknown) =>
          error instanceof AnalyticalBenchmarkError &&
          error.message ===
            "Analytical volume event count does not reconcile to canonical coverage",
      );
    });
  });
});
