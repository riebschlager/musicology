import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  commandFailure,
  commandSuccess,
  ExitCode,
  renderCommandResult,
  type CommandResult,
  type JsonObject,
  type OutputFormat,
} from "./result.ts";
import {
  ConfigurationError,
  configurationRedactionValues,
  loadConfiguration,
  repositoryRoot,
} from "../config/config.ts";
import { openSqliteConnection } from "../db/better-sqlite3.ts";
import type { IntegrityCheckResult } from "../db/connection.ts";
import {
  applyMigrations,
  getMigrationStatus,
  MigrationError,
  type MigrationStatus,
} from "../db/migrations.ts";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
type DatabaseCommand = "migrate" | "status";

function statusData(status: MigrationStatus): JsonObject {
  return {
    initialized: status.initialized,
    appliedCount: status.applied.length,
    pendingCount: status.pending.length,
    applied: status.applied.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksumSha256: migration.checksumSha256,
      appliedAtUtc: migration.appliedAtUtc,
    })),
    pending: status.pending.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksumSha256: migration.checksumSha256,
    })),
  };
}

function integrityData(integrity: IntegrityCheckResult): JsonObject {
  return {
    integrityOk: integrity.ok,
    integrityMessages: integrity.messages,
    foreignKeyViolationCount: integrity.foreignKeyViolations.length,
  };
}

function integrityFailure(commandName: string, integrity: IntegrityCheckResult): CommandResult {
  return commandFailure(commandName, ExitCode.DataError, "Database integrity validation failed.", [
    {
      code: "integrity_check_failed",
      message: `SQLite reported ${integrity.messages.length} integrity message(s) and ${integrity.foreignKeyViolations.length} foreign-key violation(s).`,
    },
  ]);
}

export function runDatabaseCommand(
  command: DatabaseCommand,
  databasePath: string,
  migrationPath = migrationsDirectory,
): CommandResult {
  const commandName = `db:${command}`;
  const connection = openSqliteConnection(databasePath);
  try {
    if (command === "migrate") {
      const result = applyMigrations(connection, migrationPath);
      const integrity = connection.checkIntegrity();
      if (!integrity.ok) {
        return integrityFailure(commandName, integrity);
      }
      return commandSuccess(
        commandName,
        result.appliedNow.length === 0
          ? `Database is up to date (${result.applied.length} migrations applied).`
          : `Applied ${result.appliedNow.length} migration(s); database is up to date.`,
        {
          ...statusData(result),
          ...integrityData(integrity),
          appliedNowCount: result.appliedNow.length,
        },
      );
    }

    const status = getMigrationStatus(connection, migrationPath);
    const integrity = connection.checkIntegrity();
    if (!integrity.ok) {
      return integrityFailure(commandName, integrity);
    }
    return commandSuccess(
      commandName,
      `Database status is valid: ${status.applied.length} applied, ${status.pending.length} pending; integrity and foreign keys passed.`,
      { ...statusData(status), ...integrityData(integrity) },
    );
  } finally {
    connection.close();
  }
}

function usageFailure(summary: string): CommandResult {
  return commandFailure("db", ExitCode.UsageError, summary, [
    { code: "invalid_arguments", message: "Usage: db.ts <migrate|status> [--json]" },
  ]);
}

function main(): void {
  let format: OutputFormat = "human";
  let result: CommandResult;
  let sensitiveValues: readonly string[] = [];

  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: { json: { type: "boolean", default: false } },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    const command = parsed.positionals[0];
    if ((command !== "migrate" && command !== "status") || parsed.positionals.length !== 1) {
      result = usageFailure("Invalid database command.");
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      result = runDatabaseCommand(command, configuration.paths.databasePath);
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      result = commandFailure(
        "db",
        ExitCode.ConfigurationError,
        "Configuration is invalid.",
        error.issues.map((issue) => ({ code: issue.code, message: issue.message })),
      );
    } else if (error instanceof MigrationError) {
      result = commandFailure("db", ExitCode.DataError, "Migration validation failed.", [
        { code: error.code, message: error.message },
      ]);
    } else if (error instanceof TypeError) {
      result = usageFailure("Invalid database command arguments.");
    } else {
      result = commandFailure("db", ExitCode.InternalError, "Database command failed.", [
        { code: "internal_error", message: "An unexpected database error occurred" },
      ]);
    }
  }

  const output = renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
