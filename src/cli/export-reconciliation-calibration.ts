import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
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
import { exportCalibrationSample } from "../reconciliation/policy.ts";
import {
  commandFailure,
  commandSuccess,
  ExitCode,
  renderCommandResult,
  type CommandResult,
  type JsonObject,
  type OutputFormat,
} from "./result.ts";

const commandName = "export:reconciliation-calibration";
const outputFilename = "reconciliation-calibration-sample.json";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

class DatabaseNotReadyError extends Error {
  constructor() {
    super(
      "Database migrations must be current before exporting a reconciliation calibration sample",
    );
    this.name = "DatabaseNotReadyError";
  }
}

class CalibrationOutputExistsError extends Error {
  constructor() {
    super("A calibration sample already exists; move or remove it before exporting a new sample");
    this.name = "CalibrationOutputExistsError";
  }
}

export function runExportReconciliationCalibrationCommand(
  connection: SqliteConnection,
  options: { readonly perStratum?: number } = {},
): CommandResult<JsonObject> {
  const sample = exportCalibrationSample(connection, options);
  return commandSuccess(
    commandName,
    `Exported ${sample.candidates.length} privacy-safe reconciliation calibration candidate(s).`,
    {
      candidateCount: sample.candidates.length,
      featureRuleVersion: sample.featureRuleVersion,
      outputFilename,
      policyVersion: sample.policy.version,
      sampleVersion: sample.sampleVersion,
    },
  );
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message: "Usage: export:reconciliation-calibration [--json] [--per-stratum <1-1000>]",
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
      options: {
        json: { type: "boolean", default: false },
        "per-stratum": { type: "string" },
      },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure("The calibration export command does not accept positional arguments.");
    } else {
      const perStratum =
        parsed.values["per-stratum"] === undefined
          ? undefined
          : Number(parsed.values["per-stratum"]);
      if (
        perStratum !== undefined &&
        (!Number.isInteger(perStratum) || perStratum < 1 || perStratum > 1000)
      ) {
        result = usageFailure("The per-stratum value must be an integer from 1 to 1000.");
      } else {
        const configuration = loadConfiguration({ repositoryRoot });
        sensitiveValues = configurationRedactionValues(configuration);
        connection = openReadonlySqliteConnection(configuration.paths.databasePath);
        const migrationStatus = getMigrationStatus(connection, migrationsDirectory);
        if (migrationStatus.applied.length === 0 || migrationStatus.pending.length > 0) {
          throw new DatabaseNotReadyError();
        }
        const sampleOptions = perStratum === undefined ? {} : { perStratum };
        const sample = exportCalibrationSample(connection, sampleOptions);
        mkdirSync(configuration.paths.outputsDirectory, { recursive: true });
        writeFileSync(
          path.join(configuration.paths.outputsDirectory, outputFilename),
          `${JSON.stringify(sample, null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        result = runExportReconciliationCalibrationCommand(connection, sampleOptions);
      }
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
    } else if (isFileExistsError(error)) {
      result = commandFailure(
        commandName,
        ExitCode.DataError,
        "Calibration export was not written.",
        [
          {
            code: "calibration_output_exists",
            message: new CalibrationOutputExistsError().message,
          },
        ],
      );
    } else if (error instanceof RangeError || error instanceof TypeError) {
      result = usageFailure("Invalid calibration export command arguments.");
    } else {
      result = commandFailure(commandName, ExitCode.InternalError, "Calibration export failed.", [
        { code: "internal_error", message: "An unexpected calibration export error occurred" },
      ]);
    }
  } finally {
    connection?.close();
  }
  const output = renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
