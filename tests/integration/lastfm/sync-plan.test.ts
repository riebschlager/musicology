import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { SqliteConnection } from "../../../src/db/connection.ts";
import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import {
  advanceLastfmSyncCursor,
  DEFAULT_LASTFM_SAFETY_OVERLAP_MS,
  fingerprintLastfmSyncScope,
  lastfmSyncDryRunWindow,
  LastfmCursorUpdatePolicy,
  LastfmSyncPlanError,
  LastfmSyncPlanErrorCode,
  planLastfmSync,
} from "../../../src/lastfm/sync-plan.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const scope = fingerprintLastfmSyncScope("synthetic-listener");

function prepareDatabase(connection: SqliteConnection): void {
  applyMigrations(connection, migrationsDirectory);
}

function insertSuccessfulApiRun(connection: SqliteConnection, completedAtEpochMs: number): number {
  return Number(
    connection
      .prepare(
        `INSERT INTO ingest_run
          (command_type, started_at_epoch_ms, completed_at_epoch_ms, status, schema_version)
         VALUES ('lastfm_api_sync', 0, ?, 'succeeded', 'synthetic')`,
      )
      .run([completedAtEpochMs]).lastInsertRowid,
  );
}

function insertLastfmEvidence(connection: SqliteConnection, scrobbledAtEpochMs: number): void {
  const runId = insertSuccessfulApiRun(connection, scrobbledAtEpochMs);
  const sourceRecordId = Number(
    connection
      .prepare(
        `INSERT INTO source_record (source_kind, ingest_run_id, accepted_at_epoch_ms)
         VALUES ('lastfm', ?, ?)`,
      )
      .run([runId, scrobbledAtEpochMs]).lastInsertRowid,
  );
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_source
        (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name,
         source_fingerprint_sha256)
       VALUES (?, 'export', ?, 'Synthetic Artist', 'Synthetic Track', ?)`,
    )
    .run([sourceRecordId, scrobbledAtEpochMs, String(sourceRecordId).padStart(64, "0")]);
}

function expectPlanError(operation: () => unknown, code: LastfmSyncPlanErrorCode): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof LastfmSyncPlanError && error.code === code,
  );
}

describe("Last.fm cursor and safety-overlap planning", () => {
  it("requires an explicit first boundary when there is no cursor or imported evidence", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      prepareDatabase(connection);
      expectPlanError(
        () => planLastfmSync(connection, { scopeFingerprintSha256: scope }),
        LastfmSyncPlanErrorCode.InitialBoundaryRequired,
      );

      assert.deepEqual(
        planLastfmSync(connection, { initialFromEpochMs: 0, scopeFingerprintSha256: scope }),
        {
          cursorUpdatePolicy: LastfmCursorUpdatePolicy.AdvanceOnSuccess,
          fromEpochMs: 0,
          source: "initial_boundary",
        },
      );
    });
  });

  it("plans first sync from the latest imported evidence with the configured overlap", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      prepareDatabase(connection);
      insertLastfmEvidence(connection, 900_000);

      assert.deepEqual(
        planLastfmSync(connection, { safetyOverlapMs: 100_000, scopeFingerprintSha256: scope }),
        {
          cursorUpdatePolicy: LastfmCursorUpdatePolicy.AdvanceOnSuccess,
          fromEpochMs: 800_000,
          source: "latest_evidence",
        },
      );
    });
  });

  it("reads the successful cursor, clips overlap at epoch, and keeps UTC timestamps unchanged", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      prepareDatabase(connection);
      const runId = insertSuccessfulApiRun(connection, 10_000);
      assert.equal(
        advanceLastfmSyncCursor(connection, {
          boundaryEpochMs: 1_000,
          cursorUpdatePolicy: LastfmCursorUpdatePolicy.AdvanceOnSuccess,
          lastSuccessfulIngestRunId: runId,
          scopeFingerprintSha256: scope,
          updatedAtEpochMs: 10_000,
        }),
        1_000,
      );
      assert.deepEqual(
        planLastfmSync(connection, { safetyOverlapMs: 5_000, scopeFingerprintSha256: scope }),
        {
          cursorBoundaryEpochMs: 1_000,
          cursorUpdatePolicy: LastfmCursorUpdatePolicy.AdvanceOnSuccess,
          fromEpochMs: 0,
          source: "cursor",
        },
      );

      const dstBoundary = Date.parse("2026-03-08T08:00:00.000Z");
      const dstRunId = insertSuccessfulApiRun(connection, dstBoundary + 1);
      advanceLastfmSyncCursor(connection, {
        boundaryEpochMs: dstBoundary,
        cursorUpdatePolicy: LastfmCursorUpdatePolicy.AdvanceOnSuccess,
        lastSuccessfulIngestRunId: dstRunId,
        scopeFingerprintSha256: scope,
        updatedAtEpochMs: dstBoundary + 1,
      });
      assert.equal(
        planLastfmSync(connection, { scopeFingerprintSha256: scope }).fromEpochMs,
        dstBoundary - DEFAULT_LASTFM_SAFETY_OVERLAP_MS,
      );
    });
  });

  it("uses explicit recovery bounds without authorizing cursor advancement and exposes dry-run data", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      prepareDatabase(connection);
      const plan = planLastfmSync(connection, {
        fromEpochMs: 100,
        scopeFingerprintSha256: scope,
        toEpochMs: 200,
      });
      assert.deepEqual(plan, {
        cursorUpdatePolicy: LastfmCursorUpdatePolicy.Preserve,
        fromEpochMs: 100,
        source: "override",
        toEpochMs: 200,
      });
      assert.deepEqual(lastfmSyncDryRunWindow(plan), {
        cursorUpdatePolicy: "preserve",
        fromEpochMs: 100,
        source: "override",
        toEpochMs: 200,
      });
      const successfulRunId = insertSuccessfulApiRun(connection, 201);
      expectPlanError(
        () =>
          advanceLastfmSyncCursor(connection, {
            boundaryEpochMs: 200,
            cursorUpdatePolicy: plan.cursorUpdatePolicy,
            lastSuccessfulIngestRunId: successfulRunId,
            scopeFingerprintSha256: scope,
            updatedAtEpochMs: 201,
          }),
        LastfmSyncPlanErrorCode.InvalidCursor,
      );
    });
  });

  it("rejects invalid ranges and invalid epoch values before issuing a request", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      prepareDatabase(connection);
      for (const options of [
        { fromEpochMs: 200, toEpochMs: 100 },
        { fromEpochMs: -1 },
        { initialFromEpochMs: 1.5 },
        { initialFromEpochMs: 0, safetyOverlapMs: -1 },
      ]) {
        expectPlanError(
          () => planLastfmSync(connection, { ...options, scopeFingerprintSha256: scope }),
          LastfmSyncPlanErrorCode.InvalidBounds,
        );
      }
    });
  });

  it("keeps cursor boundaries monotonic even if a later successful run reports an older boundary", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      prepareDatabase(connection);
      const firstRun = insertSuccessfulApiRun(connection, 20_000);
      const secondRun = insertSuccessfulApiRun(connection, 30_000);
      advanceLastfmSyncCursor(connection, {
        boundaryEpochMs: 10_000,
        cursorUpdatePolicy: LastfmCursorUpdatePolicy.AdvanceOnSuccess,
        lastSuccessfulIngestRunId: firstRun,
        scopeFingerprintSha256: scope,
        updatedAtEpochMs: 20_000,
      });
      assert.equal(
        advanceLastfmSyncCursor(connection, {
          boundaryEpochMs: 9_000,
          cursorUpdatePolicy: LastfmCursorUpdatePolicy.AdvanceOnSuccess,
          lastSuccessfulIngestRunId: secondRun,
          scopeFingerprintSha256: scope,
          updatedAtEpochMs: 30_000,
        }),
        10_000,
      );
    });
  });

  it("does not create a cursor from an incomplete, failed, or unrelated ingest run", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      prepareDatabase(connection);
      const runningRunId = Number(
        connection
          .prepare(
            `INSERT INTO ingest_run (command_type, started_at_epoch_ms, status, schema_version)
             VALUES ('lastfm_api_sync', 0, 'running', 'synthetic')`,
          )
          .run().lastInsertRowid,
      );
      const failedRunId = Number(
        connection
          .prepare(
            `INSERT INTO ingest_run
              (command_type, started_at_epoch_ms, completed_at_epoch_ms, status, schema_version)
             VALUES ('lastfm_api_sync', 0, 1, 'failed', 'synthetic')`,
          )
          .run().lastInsertRowid,
      );
      const unrelatedRunId = Number(
        connection
          .prepare(
            `INSERT INTO ingest_run
              (command_type, started_at_epoch_ms, completed_at_epoch_ms, status, schema_version)
             VALUES ('reconciliation', 0, 1, 'succeeded', 'synthetic')`,
          )
          .run().lastInsertRowid,
      );

      for (const lastSuccessfulIngestRunId of [runningRunId, failedRunId, unrelatedRunId]) {
        expectPlanError(
          () =>
            advanceLastfmSyncCursor(connection, {
              boundaryEpochMs: 1_000,
              cursorUpdatePolicy: LastfmCursorUpdatePolicy.AdvanceOnSuccess,
              lastSuccessfulIngestRunId,
              scopeFingerprintSha256: scope,
              updatedAtEpochMs: 1_001,
            }),
          LastfmSyncPlanErrorCode.InvalidCursor,
        );
      }

      assert.equal(
        connection
          .prepare<{ readonly count: number }>("SELECT count(*) AS count FROM sync_cursor")
          .get()?.count,
        0,
      );
    });
  });

  it("lets an explicit initial boundary take precedence over imported evidence before any cursor exists", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      prepareDatabase(connection);
      insertLastfmEvidence(connection, 900_000);
      assert.deepEqual(
        planLastfmSync(connection, {
          initialFromEpochMs: 100_000,
          scopeFingerprintSha256: scope,
        }),
        {
          cursorUpdatePolicy: LastfmCursorUpdatePolicy.AdvanceOnSuccess,
          fromEpochMs: 100_000,
          source: "initial_boundary",
        },
      );
    });
  });
});
