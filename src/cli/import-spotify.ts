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
import { IngestLifecycleError } from "../importers/lifecycle.ts";
import { importSpotifyFiles, type SpotifyImportSummary } from "../importers/spotify/index.ts";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const commandName = "import:spotify";

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before importing Spotify evidence");
    this.name = "DatabaseNotReadyError";
  }
}

function summaryData(summary: SpotifyImportSummary): JsonObject {
  return {
    runId: summary.runId,
    noOp: summary.noOp,
    fingerprintVersion: summary.fingerprintVersion,
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
    nonMusic: {
      episodeOrAudiobook: summary.nonMusic.episodeOrAudiobook,
      videoOrUnsupported: summary.nonMusic.videoOrUnsupported,
    },
  };
}

export interface RunSpotifyImportCommandOptions {
  readonly candidatePaths: readonly string[];
  readonly connection: SqliteConnection;
  readonly evidenceRoot: string;
  readonly now?: () => number;
  readonly schemaVersion: string;
}

export function runSpotifyImportCommand(
  options: RunSpotifyImportCommandOptions,
): CommandResult<JsonObject> {
  const summary = importSpotifyFiles(options);
  return commandSuccess(
    commandName,
    summary.noOp
      ? "Spotify import completed as a no-op; all supported file content was already registered."
      : `Spotify import completed: ${summary.records.accepted} accepted, ${summary.records.duplicated} duplicated, ${summary.records.excluded} excluded, ${summary.records.rejected} rejected.`,
    summaryData(summary),
  );
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message: "Usage: import:spotify [--json] <path> [path ...]",
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
      result = usageFailure("At least one explicit Spotify audio export path is required.");
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      connection = openSqliteConnection(configuration.paths.databasePath);
      const migrationStatus = getMigrationStatus(connection, migrationsDirectory);
      const currentMigration = migrationStatus.applied.at(-1);
      if (currentMigration === undefined || migrationStatus.pending.length > 0) {
        throw new DatabaseNotReadyError();
      }
      result = runSpotifyImportCommand({
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
      result = commandFailure(commandName, ExitCode.DataError, "Spotify import failed.", [
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
      result = usageFailure("Invalid Spotify import arguments.");
    } else {
      result = commandFailure(commandName, ExitCode.InternalError, "Spotify import failed.", [
        { code: "internal_error", message: "An unexpected import error occurred" },
      ]);
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
