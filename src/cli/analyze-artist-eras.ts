import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateArtistEraAnalysis } from "../analytics/artist-eras.ts";
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

const commandName = "analyze:artist-eras";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before analyzing artist eras");
    this.name = "DatabaseNotReadyError";
  }
}

export function runArtistEraCommand(
  connection: SqliteConnection,
  presentationTimezone: string,
  parameters: unknown = {},
): CommandResult<JsonObject> {
  const analysis = generateArtistEraAnalysis({ connection, parameters, presentationTimezone });
  return commandSuccess(
    commandName,
    `Artist-era analysis produced ${analysis.result.intervals.length} interval(s).`,
    analysis as unknown as JsonObject,
  );
}

export function renderArtistEraHuman(data: ReturnType<typeof generateArtistEraAnalysis>): string {
  const lines = [
    "Artist eras.",
    `Intervals: ${data.result.intervals.length}; canonical events: ${data.eventCount}.`,
    `Timezone: ${data.presentationTimezone}; Spotify source coverage: ${data.metadataCoverage.spotifySource?.availableEventCount ?? 0}/${data.eventCount}; Last.fm source coverage: ${data.metadataCoverage.lastfmSource?.availableEventCount ?? 0}/${data.eventCount}.`,
    ...data.result.intervals.map(
      (interval) =>
        `${interval.windowStart}–${interval.windowEndExclusive}: artist ${interval.artistId}; ${interval.playCount} plays; strength ${interval.strength}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message:
        "Usage: analyze:artist-eras [--json] [--window-size-months N] [--rolling-window-count N] [--minimum-window-play-count N] [--minimum-rolling-play-count N] [--minimum-listening-share N] [--maximum-rank N] [--minimum-consecutive-active-windows N] [--minimum-earlier-baseline-change N]",
    },
  ]);
}

function main(): void {
  let connection: SqliteConnection | undefined;
  let format: OutputFormat = "human";
  let result: CommandResult<JsonObject> | CommandResult;
  let analysis: ReturnType<typeof generateArtistEraAnalysis> | undefined;
  let sensitiveValues: readonly string[] = [];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        "maximum-rank": { type: "string" },
        "minimum-consecutive-active-windows": { type: "string" },
        "minimum-earlier-baseline-change": { type: "string" },
        "minimum-listening-share": { type: "string" },
        "minimum-rolling-play-count": { type: "string" },
        "minimum-window-play-count": { type: "string" },
        json: { type: "boolean", default: false },
        "rolling-window-count": { type: "string" },
        "window-size-months": { type: "string" },
      },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure("The artist-era command does not accept positional arguments.");
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
      connection = openReadonlySqliteConnection(configuration.paths.databasePath);
      const status = getMigrationStatus(connection, migrationsDirectory);
      if (status.applied.length === 0 || status.pending.length > 0)
        throw new DatabaseNotReadyError();
      const values = parsed.values;
      const parameters = {
        ...(values["window-size-months"] === undefined
          ? {}
          : { windowSizeMonths: Number(values["window-size-months"]) }),
        ...(values["rolling-window-count"] === undefined
          ? {}
          : { rollingWindowCount: Number(values["rolling-window-count"]) }),
        ...(values["minimum-window-play-count"] === undefined
          ? {}
          : { minimumWindowPlayCount: Number(values["minimum-window-play-count"]) }),
        ...(values["minimum-rolling-play-count"] === undefined
          ? {}
          : { minimumRollingPlayCount: Number(values["minimum-rolling-play-count"]) }),
        ...(values["minimum-listening-share"] === undefined
          ? {}
          : { minimumListeningShare: Number(values["minimum-listening-share"]) }),
        ...(values["maximum-rank"] === undefined
          ? {}
          : { maximumRank: Number(values["maximum-rank"]) }),
        ...(values["minimum-consecutive-active-windows"] === undefined
          ? {}
          : {
              minimumConsecutiveActiveWindows: Number(values["minimum-consecutive-active-windows"]),
            }),
        ...(values["minimum-earlier-baseline-change"] === undefined
          ? {}
          : { minimumEarlierBaselineChange: Number(values["minimum-earlier-baseline-change"]) }),
      };
      analysis = generateArtistEraAnalysis({
        connection,
        parameters,
        presentationTimezone: configuration.presentationTimezone,
      });
      result = commandSuccess(
        commandName,
        `Artist-era analysis produced ${analysis.result.intervals.length} interval(s).`,
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
      result = usageFailure("Invalid artist-era command arguments.");
    } else {
      result = commandFailure(commandName, ExitCode.InternalError, "Artist-era analysis failed.", [
        { code: "internal_error", message: "An unexpected artist-era analysis error occurred" },
      ]);
    }
  } finally {
    connection?.close();
  }
  const output =
    result.status === "success" && format === "human" && analysis !== undefined
      ? renderArtistEraHuman(analysis)
      : renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
