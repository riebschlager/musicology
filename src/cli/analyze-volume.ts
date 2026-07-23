import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AnalyticalResultContractError } from "../analytics/result.ts";
import { generateVolumeAnalysis, type VolumeParameters } from "../analytics/volume.ts";
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

const commandName = "analyze:volume";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before analyzing listening volume");
    this.name = "DatabaseNotReadyError";
  }
}

export function runVolumeCommand(
  connection: SqliteConnection,
  presentationTimezone: string,
  parameters: unknown = {},
): CommandResult<JsonObject> {
  const analysis = generateVolumeAnalysis({ connection, parameters, presentationTimezone });
  return commandSuccess(
    commandName,
    `Listening-volume analysis produced ${analysis.result.rows.length} period(s).`,
    analysis as unknown as JsonObject,
  );
}

export function renderVolumeHuman(data: ReturnType<typeof generateVolumeAnalysis>): string {
  const spotifyDuration = data.metadataCoverage.spotifyDuration;
  if (spotifyDuration === undefined) {
    throw new Error("Listening-volume result is missing Spotify duration coverage");
  }
  const lines = [
    `${data.result.metricLabel}.`,
    `Periods: ${data.result.rows.length}; total: ${data.result.totalValue}; canonical events: ${data.eventCount}.`,
    `Timezone: ${data.presentationTimezone}; Spotify duration coverage: ${spotifyDuration.availableEventCount}/${data.eventCount}.`,
    ...data.result.rows.map((row) => `${row.period}: ${row.value} (rolling ${row.rollingValue})`),
  ];
  return `${lines.join("\n")}\n`;
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message:
        "Usage: analyze:volume [--json] [--grain day|iso_week|month|quarter|year] [--metric play_count|play_count_at_least_ms|listened_ms] [--from UTC_TIMESTAMP --to UTC_TIMESTAMP] [--minimum-duration-ms N] [--rolling-window-periods N] [--exclude-unresolved]",
    },
  ]);
}

function main(): void {
  let connection: SqliteConnection | undefined;
  let format: OutputFormat = "human";
  let result: CommandResult<JsonObject> | CommandResult;
  let analysis: ReturnType<typeof generateVolumeAnalysis> | undefined;
  let sensitiveValues: readonly string[] = [];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        "exclude-unresolved": { type: "boolean", default: false },
        from: { type: "string" },
        grain: { type: "string" },
        json: { type: "boolean", default: false },
        "minimum-duration-ms": { type: "string" },
        metric: { type: "string" },
        "rolling-window-periods": { type: "string" },
        to: { type: "string" },
      },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure("The listening-volume command does not accept positional arguments.");
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
      connection = openReadonlySqliteConnection(configuration.paths.databasePath);
      const status = getMigrationStatus(connection, migrationsDirectory);
      if (status.applied.length === 0 || status.pending.length > 0)
        throw new DatabaseNotReadyError();
      const parameters: Partial<VolumeParameters> = {
        ...(parsed.values.from === undefined ? {} : { startInclusive: parsed.values.from }),
        ...(parsed.values.to === undefined ? {} : { endExclusive: parsed.values.to }),
        ...(parsed.values.grain === undefined
          ? {}
          : { grain: parsed.values.grain as VolumeParameters["grain"] }),
        includeUnresolved: !parsed.values["exclude-unresolved"],
        ...(parsed.values.metric === undefined
          ? {}
          : { metric: parsed.values.metric as VolumeParameters["metric"] }),
        ...(parsed.values["minimum-duration-ms"] === undefined
          ? {}
          : { minimumDurationMs: Number(parsed.values["minimum-duration-ms"]) }),
        ...(parsed.values["rolling-window-periods"] === undefined
          ? {}
          : { rollingWindowPeriods: Number(parsed.values["rolling-window-periods"]) }),
      };
      analysis = generateVolumeAnalysis({
        connection,
        parameters,
        presentationTimezone: configuration.presentationTimezone,
      });
      result = commandSuccess(
        commandName,
        `Listening-volume analysis produced ${analysis.result.rows.length} period(s).`,
        analysis as unknown as JsonObject,
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
    } else if (
      error instanceof AnalyticalResultContractError ||
      error instanceof RangeError ||
      error instanceof TypeError
    ) {
      result = usageFailure("Invalid listening-volume command arguments.");
    } else {
      result = commandFailure(
        commandName,
        ExitCode.InternalError,
        "Listening-volume analysis failed.",
        [
          {
            code: "internal_error",
            message: "An unexpected listening-volume analysis error occurred",
          },
        ],
      );
    }
  } finally {
    connection?.close();
  }
  const output =
    result.status === "success" && format === "human" && analysis !== undefined
      ? renderVolumeHuman(analysis)
      : renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
