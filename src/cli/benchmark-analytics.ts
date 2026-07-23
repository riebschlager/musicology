import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { benchmarkAnalyses, AnalyticalBenchmarkError } from "../analytics/benchmark.ts";
import {
  ConfigurationError,
  configurationRedactionValues,
  loadConfiguration,
  repositoryRoot,
} from "../config/config.ts";
import { openReadonlySqliteConnection } from "../db/better-sqlite3.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { getMigrationStatus, MigrationError } from "../db/migrations.ts";
import {
  commandFailure,
  commandSuccess,
  ExitCode,
  renderCommandResult,
  type CommandResult,
  type JsonObject,
  type OutputFormat,
} from "./result.ts";

const commandName = "benchmark:analytics";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before benchmarking analytics");
    this.name = "DatabaseNotReadyError";
  }
}

function main(): void {
  let connection: SqliteConnection | undefined;
  let format: OutputFormat = "human";
  let sensitiveValues: readonly string[] = [];
  let result: CommandResult<JsonObject> | CommandResult;
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: { json: { type: "boolean", default: false } },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure(
        "The analytics benchmark command does not accept positional arguments.",
      );
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
      connection = openReadonlySqliteConnection(configuration.paths.databasePath);
      const status = getMigrationStatus(connection, migrationsDirectory);
      if (status.applied.length === 0 || status.pending.length > 0) {
        throw new DatabaseNotReadyError();
      }
      const benchmark = benchmarkAnalyses(connection, configuration.presentationTimezone);
      result = commandSuccess(
        commandName,
        `Benchmarked ${benchmark.measurements.length} analyses over ${benchmark.canonicalEventCount} canonical event(s).`,
        benchmark as unknown as JsonObject,
      );
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      result = commandFailure(
        commandName,
        ExitCode.ConfigurationError,
        "Configuration is invalid.",
        error.issues.map((issue) => ({ code: issue.code, message: issue.message })),
      );
    } else if (error instanceof MigrationError || error instanceof DatabaseNotReadyError) {
      result = commandFailure(commandName, ExitCode.DataError, "Database is not ready.", [
        { code: "database_not_ready", message: error.message },
      ]);
    } else if (error instanceof AnalyticalBenchmarkError) {
      result = commandFailure(commandName, ExitCode.DataError, "Analytics benchmark failed.", [
        { code: "benchmark_reconciliation_failed", message: error.message },
      ]);
    } else if (error instanceof TypeError) {
      result = usageFailure("Invalid analytics benchmark command arguments.");
    } else {
      result = commandFailure(commandName, ExitCode.InternalError, "Analytics benchmark failed.", [
        { code: "internal_error", message: "An unexpected analytics benchmark error occurred" },
      ]);
    }
  } finally {
    connection?.close();
  }
  const output = renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    { code: "invalid_arguments", message: "Usage: benchmark:analytics [--json]" },
  ]);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
