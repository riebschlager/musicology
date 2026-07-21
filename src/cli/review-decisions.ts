import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  configurationRedactionValues,
  ConfigurationError,
  loadConfiguration,
  repositoryRoot,
} from "../config/config.ts";
import { openReadonlySqliteConnection, openSqliteConnection } from "../db/better-sqlite3.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { getMigrationStatus, MigrationError } from "../db/migrations.ts";
import {
  exportManualReview,
  importManualDecisions,
  parseManualDecisionArtifact,
} from "../reconciliation/manual-decisions.ts";
import {
  commandFailure,
  commandSuccess,
  ExitCode,
  renderCommandResult,
  type CommandResult,
  type JsonObject,
  type OutputFormat,
} from "./result.ts";

const commandName = "review:decisions";
const outputFilename = "manual-review-decisions.json";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before reviewing decisions.");
    this.name = "DatabaseNotReadyError";
  }
}
function ensureReady(connection: SqliteConnection): void {
  const status = getMigrationStatus(connection, migrationsDirectory);
  if (status.applied.length === 0 || status.pending.length > 0) throw new DatabaseNotReadyError();
}
function safeSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function main(): void {
  let connection: SqliteConnection | undefined;
  let format: OutputFormat = "human";
  let result: CommandResult<JsonObject>;
  let sensitiveValues: readonly string[] = [];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: false,
      strict: true,
      options: { json: { type: "boolean", default: false }, import: { type: "string" } },
    });
    format = parsed.values.json ? "json" : "human";
    const configuration = loadConfiguration({ repositoryRoot });
    sensitiveValues = configurationRedactionValues(configuration);
    if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
    if (parsed.values.import === undefined) {
      connection = openReadonlySqliteConnection(configuration.paths.databasePath);
      ensureReady(connection);
      const outputPath = path.join(configuration.paths.outputsDirectory, outputFilename);
      if (existsSync(outputPath)) throw new TypeError("Manual review output already exists");
      mkdirSync(configuration.paths.outputsDirectory, { recursive: true });
      const review = exportManualReview(connection);
      writeFileSync(outputPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
      result = commandSuccess(commandName, "Manual review candidates exported.", {
        candidateCount: (review.candidates as readonly unknown[]).length,
        outputFilename,
      });
    } else {
      const artifact = parseManualDecisionArtifact(
        JSON.parse(readFileSync(parsed.values.import, "utf8")),
      );
      connection = openSqliteConnection(configuration.paths.databasePath);
      ensureReady(connection);
      let backupFilename: string | null = null;
      if (artifact.decisions.length > 0) {
        backupFilename = `manual-decisions-backup-${Date.now()}.sqlite`;
        connection.execute(
          `VACUUM INTO ${safeSqlLiteral(path.join(path.dirname(configuration.paths.databasePath), backupFilename))}`,
        );
      }
      const summary = importManualDecisions(connection, artifact);
      result = commandSuccess(commandName, "Manual decisions imported transactionally.", {
        alreadyApplied: summary.alreadyApplied,
        backupFilename,
        imported: summary.imported,
      });
    }
  } catch (error) {
    const invalid =
      error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError;
    const unavailable = error instanceof DatabaseNotReadyError || error instanceof MigrationError;
    const exitCode =
      invalid || unavailable
        ? ExitCode.DataError
        : error instanceof ConfigurationError
          ? ExitCode.ConfigurationError
          : ExitCode.InternalError;
    result = commandFailure(
      commandName,
      exitCode,
      exitCode === ExitCode.InternalError
        ? "Manual decision review failed."
        : "Manual decision artifact could not be processed.",
      [
        {
          code: invalid
            ? "invalid_manual_decision_artifact"
            : unavailable
              ? "database_not_ready"
              : error instanceof ConfigurationError
                ? "configuration_error"
                : "internal_error",
          message: error instanceof Error ? error.message : "Manual decision processing failed",
        },
      ],
    );
  } finally {
    connection?.close();
  }
  const output = renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
