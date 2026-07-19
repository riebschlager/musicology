import path from "node:path";
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
import type { SqliteConnection } from "../db/connection.ts";
import { getMigrationStatus, MigrationError } from "../db/migrations.ts";
import {
  importLastfmExportFiles,
  type LastfmExportImportSummary,
} from "../importers/lastfm-export/index.ts";
import { IngestLifecycleError } from "../importers/lifecycle.ts";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const commandName = "import:lastfm-export";

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before importing Last.fm export evidence");
    this.name = "DatabaseNotReadyError";
  }
}

function summaryData(summary: LastfmExportImportSummary): JsonObject {
  return {
    runId: summary.runId,
    noOp: summary.noOp,
    fingerprintVersions: {
      source: summary.fingerprintVersions.source,
      overlap: summary.fingerprintVersions.overlap,
    },
    files: {
      discovered: summary.files.discovered,
      registered: summary.files.registered,
      noOp: summary.files.noOp,
      unsupported: summary.files.unsupported,
    },
    records: {
      discovered: summary.records.discovered,
      accepted: summary.records.accepted,
      duplicated: summary.records.duplicated,
      excluded: summary.records.excluded,
      rejected: summary.records.rejected,
    },
  };
}

export interface RunLastfmExportImportCommandOptions {
  readonly candidatePaths: readonly string[];
  readonly connection: SqliteConnection;
  readonly evidenceRoot: string;
  readonly now?: () => number;
  readonly schemaVersion: string;
}

export function runLastfmExportImportCommand(
  options: RunLastfmExportImportCommandOptions,
): CommandResult<JsonObject> {
  const summary = importLastfmExportFiles(options);
  return commandSuccess(
    commandName,
    summary.noOp
      ? "Last.fm export import completed as a no-op; all supported file content was already registered."
      : `Last.fm export import completed: ${summary.records.accepted} accepted, ${summary.records.duplicated} duplicated, ${summary.records.rejected} rejected.`,
    summaryData(summary),
  );
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message: "Usage: import:lastfm-export [--json] <path> [path ...]",
    },
  ]);
}

function main(): void {
  let connection: SqliteConnection | undefined;
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
    if (parsed.positionals.length === 0) {
      result = usageFailure("At least one explicit Last.fm export path is required.");
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      connection = openSqliteConnection(configuration.paths.databasePath);
      const migrationStatus = getMigrationStatus(connection, migrationsDirectory);
      const currentMigration = migrationStatus.applied.at(-1);
      if (currentMigration === undefined || migrationStatus.pending.length > 0) {
        throw new DatabaseNotReadyError();
      }
      result = runLastfmExportImportCommand({
        candidatePaths: parsed.positionals.map((candidatePath) =>
          path.resolve(process.cwd(), candidatePath),
        ),
        connection,
        evidenceRoot: configuration.paths.inputsDirectory,
        schemaVersion: String(currentMigration.version),
      });
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      result = commandFailure(
        commandName,
        ExitCode.ConfigurationError,
        "Configuration is invalid.",
        error.issues.map((issue) => ({ code: issue.code, message: issue.message })),
      );
    } else if (error instanceof IngestLifecycleError) {
      result = commandFailure(commandName, ExitCode.DataError, "Last.fm export import failed.", [
        { code: error.code, message: error.safeSummary },
      ]);
    } else if (error instanceof MigrationError) {
      result = commandFailure(commandName, ExitCode.DataError, "Migration validation failed.", [
        { code: error.code, message: error.message },
      ]);
    } else if (error instanceof DatabaseNotReadyError) {
      result = commandFailure(commandName, ExitCode.DataError, "Database is not ready.", [
        { code: "database_not_ready", message: error.message },
      ]);
    } else if (error instanceof TypeError) {
      result = usageFailure("Invalid Last.fm export import arguments.");
    } else {
      result = commandFailure(
        commandName,
        ExitCode.InternalError,
        "Last.fm export import failed.",
        [{ code: "internal_error", message: "An unexpected import error occurred" }],
      );
    }
  } finally {
    connection?.close();
  }

  const output = renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
