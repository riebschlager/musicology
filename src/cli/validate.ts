import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
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
import { openReadonlySqliteConnection } from "../db/better-sqlite3.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { getMigrationStatus, MigrationError } from "../db/migrations.ts";
import { validateEvidenceLayer, type EvidenceValidationResult } from "../validation/evidence.ts";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const commandName = "validate";

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before validating historical evidence");
    this.name = "DatabaseNotReadyError";
  }
}

function validationData(validation: EvidenceValidationResult): JsonObject {
  return {
    ok: validation.ok,
    checked: validation.checked,
    integrity: {
      ok: validation.integrity.ok,
      messageCount: validation.integrity.messages.length,
      foreignKeyViolationCount: validation.integrity.foreignKeyViolations.length,
    },
    findings: validation.findings.map((finding) => ({
      code: finding.code,
      message: finding.message,
    })),
  };
}

export interface RunValidationCommandOptions {
  readonly connection: SqliteConnection;
  readonly evidenceRoot: string;
}

export function runValidationCommand(
  options: RunValidationCommandOptions,
): CommandResult<JsonObject> {
  const validation = validateEvidenceLayer(options.connection, options.evidenceRoot);
  if (!validation.ok) {
    return commandFailure(
      commandName,
      ExitCode.DataError,
      `Evidence validation failed with ${validation.errors.length} invariant error(s).`,
      validation.errors,
    );
  }
  return commandSuccess(
    commandName,
    `Evidence validation passed; ${validation.findings.length} non-fatal archive baseline finding(s) reported.`,
    validationData(validation),
  );
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    { code: "invalid_arguments", message: "Usage: validate [--json]" },
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
    if (parsed.positionals.length > 0) {
      result = usageFailure("The validation command does not accept positional arguments.");
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      if (!existsSync(configuration.paths.databasePath)) {
        throw new DatabaseNotReadyError();
      }
      connection = openReadonlySqliteConnection(configuration.paths.databasePath);
      const migrationStatus = getMigrationStatus(connection, migrationsDirectory);
      if (migrationStatus.applied.length === 0 || migrationStatus.pending.length > 0) {
        throw new DatabaseNotReadyError();
      }
      result = runValidationCommand({
        connection,
        evidenceRoot: configuration.paths.inputsDirectory,
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
    } else if (error instanceof MigrationError) {
      result = commandFailure(commandName, ExitCode.DataError, "Migration validation failed.", [
        { code: error.code, message: error.message },
      ]);
    } else if (error instanceof DatabaseNotReadyError) {
      result = commandFailure(commandName, ExitCode.DataError, "Database is not ready.", [
        { code: "database_not_ready", message: error.message },
      ]);
    } else if (error instanceof TypeError) {
      result = usageFailure("Invalid validation command arguments.");
    } else {
      result = commandFailure(commandName, ExitCode.InternalError, "Evidence validation failed.", [
        { code: "internal_error", message: "An unexpected validation error occurred" },
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
