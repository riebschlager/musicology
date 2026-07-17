import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { SqliteConnection, SqliteRow } from "./connection.ts";

export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
export const MIGRATION_TABLE_NAME = "schema_migration";

const CREATE_MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE_NAME} (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum_sha256 TEXT NOT NULL,
    applied_at_utc TEXT NOT NULL
  ) STRICT
`;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly path: string;
  readonly checksumSha256: string;
  readonly sql: string;
}

export interface AppliedMigration extends SqliteRow {
  readonly version: number;
  readonly name: string;
  readonly checksumSha256: string;
  readonly appliedAtUtc: string;
}

export interface MigrationStatus {
  readonly initialized: boolean;
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationFile[];
}

export interface MigrationRunResult extends MigrationStatus {
  readonly appliedNow: readonly AppliedMigration[];
}

export type MigrationErrorCode =
  | "checksum_drift"
  | "invalid_migration_filename"
  | "invalid_migration_order"
  | "migration_failed"
  | "migration_history_mismatch";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
    this.code = code;
  }
}

interface MigrationTableRow extends SqliteRow {
  readonly version: number;
  readonly name: string;
  readonly checksum_sha256: string;
  readonly applied_at_utc: string;
}

interface TableExistsRow extends SqliteRow {
  readonly found: number;
}

function checksum(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** Loads and validates a gap-free sequence of `0001_description.sql` migration files. */
export function loadMigrationFiles(migrationsDirectory: string): readonly MigrationFile[] {
  const directory = path.resolve(migrationsDirectory);
  const sqlFileNames = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const migrations = sqlFileNames.map((fileName): MigrationFile => {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (match === null) {
      throw new MigrationError(
        "invalid_migration_filename",
        `Migration ${fileName} must follow the 0001_lowercase_description.sql naming convention`,
      );
    }

    const versionText = match[1];
    const name = match[2];
    if (versionText === undefined || name === undefined) {
      throw new MigrationError("invalid_migration_filename", `Migration ${fileName} is invalid`);
    }

    const migrationPath = path.join(directory, fileName);
    const contents = readFileSync(migrationPath);
    return {
      version: Number.parseInt(versionText, 10),
      name,
      fileName,
      path: migrationPath,
      checksumSha256: checksum(contents),
      sql: contents.toString("utf8"),
    };
  });

  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new MigrationError(
        "invalid_migration_order",
        `Expected migration version ${String(expectedVersion).padStart(4, "0")}, found ${migration.fileName}`,
      );
    }
  }

  return migrations;
}

function migrationTableExists(connection: SqliteConnection): boolean {
  return (
    connection
      .prepare<TableExistsRow>(
        `SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ?`,
      )
      .get([MIGRATION_TABLE_NAME])?.found === 1
  );
}

function readAppliedMigrations(connection: SqliteConnection): readonly AppliedMigration[] {
  if (!migrationTableExists(connection)) {
    return [];
  }

  return connection
    .prepare<MigrationTableRow>(
      `SELECT version, name, checksum_sha256, applied_at_utc
       FROM ${MIGRATION_TABLE_NAME}
       ORDER BY version`,
    )
    .all()
    .map((row) => ({
      version: row.version,
      name: row.name,
      checksumSha256: row.checksum_sha256,
      appliedAtUtc: row.applied_at_utc,
    }));
}

function validateAppliedHistory(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): void {
  for (const [index, recorded] of applied.entries()) {
    const expectedVersion = index + 1;
    if (recorded.version !== expectedVersion) {
      throw new MigrationError(
        "migration_history_mismatch",
        `Applied migration history is not contiguous at version ${recorded.version}`,
      );
    }

    const file = files[index];
    if (file === undefined) {
      throw new MigrationError(
        "migration_history_mismatch",
        `Applied migration ${String(recorded.version).padStart(4, "0")}_${recorded.name}.sql is missing from disk`,
      );
    }
    if (file.version !== recorded.version || file.name !== recorded.name) {
      throw new MigrationError(
        "migration_history_mismatch",
        `Applied migration version ${recorded.version} does not match ${file.fileName}`,
      );
    }
    if (file.checksumSha256 !== recorded.checksumSha256) {
      throw new MigrationError(
        "checksum_drift",
        `Applied migration ${file.fileName} has changed since it was recorded`,
      );
    }
  }
}

export function getMigrationStatus(
  connection: SqliteConnection,
  migrationsDirectory: string,
): MigrationStatus {
  const files = loadMigrationFiles(migrationsDirectory);
  const initialized = migrationTableExists(connection);
  const applied = readAppliedMigrations(connection);
  validateAppliedHistory(files, applied);
  return {
    initialized,
    applied,
    pending: files.slice(applied.length),
  };
}

export interface ApplyMigrationsOptions {
  readonly now?: () => Date;
}

export function applyMigrations(
  connection: SqliteConnection,
  migrationsDirectory: string,
  options: ApplyMigrationsOptions = {},
): MigrationRunResult {
  const before = getMigrationStatus(connection, migrationsDirectory);
  const appliedAtUtc = (options.now ?? (() => new Date()))().toISOString();
  let activeMigration: MigrationFile | undefined;

  try {
    connection.transaction((transactionConnection) => {
      transactionConnection.execute(CREATE_MIGRATION_TABLE_SQL);
      const recordMigration = transactionConnection.prepare(
        `INSERT INTO ${MIGRATION_TABLE_NAME}
          (version, name, checksum_sha256, applied_at_utc)
         VALUES (@version, @name, @checksumSha256, @appliedAtUtc)`,
      );

      for (const migration of before.pending) {
        activeMigration = migration;
        transactionConnection.execute(migration.sql);
        recordMigration.run({
          version: migration.version,
          name: migration.name,
          checksumSha256: migration.checksumSha256,
          appliedAtUtc,
        });
      }
    });
  } catch (error) {
    if (error instanceof MigrationError) {
      throw error;
    }
    const context = activeMigration?.fileName ?? "migration metadata initialization";
    throw new MigrationError("migration_failed", `Failed to apply ${context}`, { cause: error });
  }

  const after = getMigrationStatus(connection, migrationsDirectory);
  return {
    ...after,
    appliedNow: after.applied.slice(before.applied.length),
  };
}
