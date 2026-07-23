import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateAbandonmentAnalysis } from "../analytics/abandonment.ts";
import { AnalyticalResultContractError } from "../analytics/result.ts";
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

const commandName = "analyze:abandonment";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before analyzing abandonment");
    this.name = "DatabaseNotReadyError";
  }
}

export function runAbandonmentCommand(
  connection: SqliteConnection,
  presentationTimezone: string,
  parameters: unknown = {},
): CommandResult<JsonObject> {
  const analysis = generateAbandonmentAnalysis({ connection, parameters, presentationTimezone });
  return commandSuccess(
    commandName,
    `Abandonment analysis produced ${analysis.result.artists.length} artist conclusion(s).`,
    analysis as unknown as JsonObject,
  );
}

export function renderAbandonmentHuman(
  data: ReturnType<typeof generateAbandonmentAnalysis>,
): string {
  return `${[
    "Abandonment analysis.",
    `Artists: ${data.result.artists.length}; canonical events: ${data.eventCount}.`,
    `As of: ${data.asOf ?? "no observed history"}; timezone: ${data.presentationTimezone}.`,
    ...data.result.artists.map(
      (item) =>
        `${item.lastListenAt}: artist ${item.artistId}; ${item.status}; observed ${item.observationDays} days; confidence ${item.confidence.score.toFixed(2)}`,
    ),
  ].join("\n")}\n`;
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message:
        "Usage: analyze:abandonment [--json] [--as-of UTC_ISO_TIMESTAMP] [--active-period-gap-days N] [--dormancy-days N] [--former-cadence-window-days N] [--likely-abandoned-days N] [--minimum-former-cadence-play-count N] [--minimum-historical-play-count N] [--observation-window-days N]",
    },
  ]);
}

function main(): void {
  let connection: SqliteConnection | undefined;
  let format: OutputFormat = "human";
  let result: CommandResult<JsonObject> | CommandResult;
  let analysis: ReturnType<typeof generateAbandonmentAnalysis> | undefined;
  let sensitiveValues: readonly string[] = [];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        "active-period-gap-days": { type: "string" },
        "as-of": { type: "string" },
        "dormancy-days": { type: "string" },
        "former-cadence-window-days": { type: "string" },
        json: { type: "boolean", default: false },
        "likely-abandoned-days": { type: "string" },
        "minimum-former-cadence-play-count": { type: "string" },
        "minimum-historical-play-count": { type: "string" },
        "observation-window-days": { type: "string" },
      },
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0)
      result = usageFailure("The abandonment command does not accept positional arguments.");
    else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
      connection = openReadonlySqliteConnection(configuration.paths.databasePath);
      const status = getMigrationStatus(connection, migrationsDirectory);
      if (status.applied.length === 0 || status.pending.length > 0)
        throw new DatabaseNotReadyError();
      const values = parsed.values;
      const parameters = {
        ...(values["as-of"] === undefined ? {} : { asOf: values["as-of"] }),
        ...(values["active-period-gap-days"] === undefined
          ? {}
          : { activePeriodGapDays: Number(values["active-period-gap-days"]) }),
        ...(values["dormancy-days"] === undefined
          ? {}
          : { dormancyDays: Number(values["dormancy-days"]) }),
        ...(values["former-cadence-window-days"] === undefined
          ? {}
          : { formerCadenceWindowDays: Number(values["former-cadence-window-days"]) }),
        ...(values["likely-abandoned-days"] === undefined
          ? {}
          : { likelyAbandonedDays: Number(values["likely-abandoned-days"]) }),
        ...(values["minimum-former-cadence-play-count"] === undefined
          ? {}
          : { minimumFormerCadencePlayCount: Number(values["minimum-former-cadence-play-count"]) }),
        ...(values["minimum-historical-play-count"] === undefined
          ? {}
          : { minimumHistoricalPlayCount: Number(values["minimum-historical-play-count"]) }),
        ...(values["observation-window-days"] === undefined
          ? {}
          : { observationWindowDays: Number(values["observation-window-days"]) }),
      };
      analysis = generateAbandonmentAnalysis({
        connection,
        parameters,
        presentationTimezone: configuration.presentationTimezone,
      });
      result = commandSuccess(
        commandName,
        `Abandonment analysis produced ${analysis.result.artists.length} artist conclusion(s).`,
        analysis as unknown as JsonObject,
      );
    }
  } catch (error) {
    if (error instanceof ConfigurationError)
      result = commandFailure(
        commandName,
        ExitCode.ConfigurationError,
        "Configuration is invalid.",
        error.issues.map((issue) => ({ code: issue.code, message: issue.message })),
      );
    else if (error instanceof MigrationError || error instanceof DatabaseNotReadyError)
      result = commandFailure(commandName, ExitCode.DataError, "Database is not ready.", [
        { code: "database_not_ready", message: error.message },
      ]);
    else if (
      error instanceof AnalyticalResultContractError ||
      error instanceof RangeError ||
      error instanceof TypeError
    )
      result = usageFailure("Invalid abandonment command arguments.");
    else
      result = commandFailure(commandName, ExitCode.InternalError, "Abandonment analysis failed.", [
        { code: "internal_error", message: "An unexpected abandonment analysis error occurred" },
      ]);
  } finally {
    connection?.close();
  }
  const output =
    result.status === "success" && format === "human" && analysis !== undefined
      ? renderAbandonmentHuman(analysis)
      : renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
