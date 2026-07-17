import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runDatabaseCommand } from "../../../src/cli/db.ts";
import { renderCommandResult, type JsonObject } from "../../../src/cli/result.ts";
import type { SqliteRow } from "../../../src/db/connection.ts";
import {
  applyMigrations,
  getMigrationStatus,
  loadMigrationFiles,
  MigrationError,
} from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";

interface CountRow extends SqliteRow {
  readonly count: number;
}

function withMigrationDirectory<T>(operation: (directory: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), "musicology-migrations-"));
  try {
    return operation(directory);
  } finally {
    rmSync(directory, { recursive: true });
  }
}

function writeMigration(directory: string, fileName: string, sql: string): void {
  writeFileSync(path.join(directory, fileName), sql, "utf8");
}

describe("migration runner", () => {
  it("initializes an empty database and repeats as a no-op", () => {
    withMigrationDirectory((directory) => {
      withTemporarySqliteDatabase(({ connection }) => {
        const first = applyMigrations(connection, directory, {
          now: () => new Date("2026-07-17T12:00:00.000Z"),
        });
        assert.equal(first.initialized, true);
        assert.deepEqual(first.applied, []);
        assert.deepEqual(first.pending, []);
        assert.deepEqual(first.appliedNow, []);

        const second = applyMigrations(connection, directory);
        assert.deepEqual(second.appliedNow, []);
        assert.equal(
          connection.prepare<CountRow>("SELECT count(*) AS count FROM schema_migration").get()
            ?.count,
          0,
        );
      });
    });
  });

  it("applies multiple migrations in order and reports them as applied", () => {
    withMigrationDirectory((directory) => {
      writeMigration(
        directory,
        "0001_create_artist.sql",
        "CREATE TABLE artist (id INTEGER PRIMARY KEY);",
      );
      writeMigration(directory, "0002_add_name.sql", "ALTER TABLE artist ADD COLUMN name TEXT;");

      withTemporarySqliteDatabase(({ connection }) => {
        const result = applyMigrations(connection, directory, {
          now: () => new Date("2026-07-17T12:00:00.000Z"),
        });
        assert.deepEqual(
          result.appliedNow.map(({ version, name }) => ({ version, name })),
          [
            { version: 1, name: "create_artist" },
            { version: 2, name: "add_name" },
          ],
        );
        assert.equal(result.pending.length, 0);
        assert.equal(result.applied[0]?.appliedAtUtc, "2026-07-17T12:00:00.000Z");
        assert.equal(
          connection
            .prepare<CountRow>("SELECT count(*) AS count FROM pragma_table_info('artist')")
            .get()?.count,
          2,
        );
      });
    });
  });

  it("rolls back the full pending batch when a migration fails", () => {
    withMigrationDirectory((directory) => {
      writeMigration(
        directory,
        "0001_create_artist.sql",
        "CREATE TABLE artist (id INTEGER PRIMARY KEY);",
      );
      writeMigration(directory, "0002_invalid_sql.sql", "THIS IS NOT SQL;");

      withTemporarySqliteDatabase(({ connection }) => {
        assert.throws(
          () => applyMigrations(connection, directory),
          (error: unknown) => error instanceof MigrationError && error.code === "migration_failed",
        );
        assert.equal(
          connection
            .prepare<CountRow>(
              "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('artist', 'schema_migration')",
            )
            .get()?.count,
          0,
        );
      });
    });
  });

  it("rejects checksum drift after a migration is applied", () => {
    withMigrationDirectory((directory) => {
      const fileName = "0001_create_artist.sql";
      writeMigration(directory, fileName, "CREATE TABLE artist (id INTEGER PRIMARY KEY);");

      withTemporarySqliteDatabase(({ connection }) => {
        applyMigrations(connection, directory);
        writeMigration(
          directory,
          fileName,
          "CREATE TABLE artist (id INTEGER PRIMARY KEY, name TEXT);",
        );
        assert.throws(
          () => getMigrationStatus(connection, directory),
          (error: unknown) => error instanceof MigrationError && error.code === "checksum_drift",
        );
      });
    });
  });

  it("rejects invalid filenames and gaps in migration ordering", () => {
    withMigrationDirectory((directory) => {
      writeMigration(directory, "1_bad_name.sql", "SELECT 1;");
      assert.throws(
        () => loadMigrationFiles(directory),
        (error: unknown) =>
          error instanceof MigrationError && error.code === "invalid_migration_filename",
      );
    });

    withMigrationDirectory((directory) => {
      writeMigration(directory, "0002_out_of_order.sql", "SELECT 1;");
      assert.throws(
        () => loadMigrationFiles(directory),
        (error: unknown) =>
          error instanceof MigrationError && error.code === "invalid_migration_order",
      );
    });
  });

  it("returns human-renderable and JSON-compatible migration status data", () => {
    withMigrationDirectory((directory) => {
      writeMigration(
        directory,
        "0001_create_artist.sql",
        "CREATE TABLE artist (id INTEGER PRIMARY KEY);",
      );
      withTemporarySqliteDatabase(({ databasePath }) => {
        const before = runDatabaseCommand("status", databasePath, directory);
        assert.equal(before.status, "success");
        assert.match(before.summary, /0 applied, 1 pending/);
        assert.deepEqual((before.data as JsonObject).pendingCount, 1);
        assert.match(renderCommandResult(before), /Migration status is valid/);
        assert.deepEqual(JSON.parse(renderCommandResult(before, { format: "json" })), before);

        const migrated = runDatabaseCommand("migrate", databasePath, directory);
        assert.match(migrated.summary, /Applied 1 migration/);
        assert.deepEqual((migrated.data as JsonObject).appliedNowCount, 1);

        const after = runDatabaseCommand("status", databasePath, directory);
        assert.match(after.summary, /1 applied, 0 pending/);
        assert.deepEqual((after.data as JsonObject).appliedCount, 1);
      });
    });
  });
});
