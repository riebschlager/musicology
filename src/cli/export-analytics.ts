import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  ANALYTICAL_EXPORT_DIRECTORY_NAME,
  AnalyticalExportError,
  generateAnalyticalExports,
  verifyAnalyticalExports,
  writeAnalyticalExports,
} from "../exports/analytics.ts";
import {
  commandFailure,
  commandSuccess,
  ExitCode,
  renderCommandResult,
  type CommandResult,
  type JsonObject,
  type OutputFormat,
} from "./result.ts";

const commandName = "export:analytics";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before exporting analytics");
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
      options: {
        check: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure("The analytics export command does not accept positional arguments.");
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
      connection = openReadonlySqliteConnection(configuration.paths.databasePath);
      const status = getMigrationStatus(connection, migrationsDirectory);
      if (status.applied.length === 0 || status.pending.length > 0)
        throw new DatabaseNotReadyError();
      const options = {
        connection,
        migrationsDirectory,
        presentationTimezone: configuration.presentationTimezone,
      };
      if (parsed.values.check) {
        const manifest = verifyAnalyticalExports(configuration.paths.outputsDirectory, options);
        result = commandSuccess(commandName, "Analytical exports are current.", manifest);
      } else {
        const generated = generateAnalyticalExports(options);
        writeAnalyticalExports(configuration.paths.outputsDirectory, generated);
        result = commandSuccess(
          commandName,
          `Analytical exports written to ${ANALYTICAL_EXPORT_DIRECTORY_NAME}.`,
          generated.manifest,
        );
      }
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      result = commandFailure(
        commandName,
        ExitCode.ConfigurationError,
        "Configuration is invalid.",
        error.issues,
      );
    } else if (error instanceof MigrationError || error instanceof DatabaseNotReadyError) {
      result = commandFailure(commandName, ExitCode.DataError, "Database is not ready.", [
        { code: "database_not_ready", message: error.message },
      ]);
    } else if (error instanceof AnalyticalExportError) {
      result = commandFailure(
        commandName,
        ExitCode.DataError,
        "Analytical export validation failed.",
        [{ code: error.code, message: error.message }],
      );
    } else if (error instanceof TypeError) {
      result = usageFailure("Invalid analytics export command arguments.");
    } else {
      result = commandFailure(commandName, ExitCode.InternalError, "Analytics export failed.", [
        { code: "internal_error", message: "An unexpected analytics export error occurred" },
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
    { code: "invalid_arguments", message: "Usage: export:analytics [--json] [--check]" },
  ]);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
