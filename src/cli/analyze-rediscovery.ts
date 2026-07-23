import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateRediscoveryAnalysis } from "../analytics/rediscovery.ts";
import { AnalyticalResultContractError } from "../analytics/result.ts";
import { ConfigurationError, configurationRedactionValues, loadConfiguration, repositoryRoot } from "../config/config.ts";
import { openReadonlySqliteConnection } from "../db/better-sqlite3.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { getMigrationStatus, MigrationError } from "../db/migrations.ts";
import { commandFailure, commandSuccess, ExitCode, renderCommandResult, type CommandResult, type JsonObject, type OutputFormat } from "./result.ts";

const commandName = "analyze:rediscovery";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before analyzing rediscovery");
    this.name = "DatabaseNotReadyError";
  }
}

export function runRediscoveryCommand(
  connection: SqliteConnection,
  presentationTimezone: string,
  parameters: unknown = {},
): CommandResult<JsonObject> {
  const analysis = generateRediscoveryAnalysis({ connection, parameters, presentationTimezone });
  return commandSuccess(commandName, `Rediscovery analysis produced ${analysis.result.rediscoveries.length} return(s).`, analysis as unknown as JsonObject);
}

export function renderRediscoveryHuman(data: ReturnType<typeof generateRediscoveryAnalysis>): string {
  return `${[
    "Rediscoveries.",
    `Returns: ${data.result.rediscoveries.length}; canonical events: ${data.eventCount}.`,
    `Timezone: ${data.presentationTimezone}; Spotify source coverage: ${data.metadataCoverage.spotifySource?.availableEventCount ?? 0}/${data.eventCount}; Last.fm source coverage: ${data.metadataCoverage.lastfmSource?.availableEventCount ?? 0}/${data.eventCount}.`,
    ...data.result.rediscoveries.map((item) => `${item.returnStartedAt}: ${item.scope} ${item.entityId}; ${item.classification}; gap ${item.gapDays} days; persistence ${item.persistence}`),
  ].join("\n")}\n`;
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [{
    code: "invalid_arguments",
    message: "Usage: analyze:rediscovery [--json] [--scope artist|track] [--absence-threshold-days N] [--minimum-prior-play-count N] [--return-window-days N] [--minimum-return-play-count N] [--persistence-window-days N] [--minimum-persistence-play-count N]",
  }]);
}

function main(): void {
  let connection: SqliteConnection | undefined;
  let format: OutputFormat = "human";
  let result: CommandResult<JsonObject> | CommandResult;
  let analysis: ReturnType<typeof generateRediscoveryAnalysis> | undefined;
  let sensitiveValues: readonly string[] = [];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2), allowPositionals: true, strict: true,
      options: {
        "absence-threshold-days": { type: "string" }, json: { type: "boolean", default: false }, "minimum-persistence-play-count": { type: "string" }, "minimum-prior-play-count": { type: "string" }, "minimum-return-play-count": { type: "string" }, "persistence-window-days": { type: "string" }, "return-window-days": { type: "string" }, scope: { type: "string" },
      },
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure("The rediscovery command does not accept positional arguments.");
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
      connection = openReadonlySqliteConnection(configuration.paths.databasePath);
      const status = getMigrationStatus(connection, migrationsDirectory);
      if (status.applied.length === 0 || status.pending.length > 0) throw new DatabaseNotReadyError();
      const values = parsed.values;
      const parameters = {
        ...(values.scope === undefined ? {} : { scope: values.scope }),
        ...(values["absence-threshold-days"] === undefined ? {} : { absenceThresholdDays: Number(values["absence-threshold-days"]) }),
        ...(values["minimum-prior-play-count"] === undefined ? {} : { minimumPriorPlayCount: Number(values["minimum-prior-play-count"]) }),
        ...(values["return-window-days"] === undefined ? {} : { returnWindowDays: Number(values["return-window-days"]) }),
        ...(values["minimum-return-play-count"] === undefined ? {} : { minimumReturnPlayCount: Number(values["minimum-return-play-count"]) }),
        ...(values["persistence-window-days"] === undefined ? {} : { persistenceWindowDays: Number(values["persistence-window-days"]) }),
        ...(values["minimum-persistence-play-count"] === undefined ? {} : { minimumPersistencePlayCount: Number(values["minimum-persistence-play-count"]) }),
      };
      analysis = generateRediscoveryAnalysis({ connection, parameters, presentationTimezone: configuration.presentationTimezone });
      result = commandSuccess(commandName, `Rediscovery analysis produced ${analysis.result.rediscoveries.length} return(s).`, analysis as unknown as JsonObject);
    }
  } catch (error) {
    if (error instanceof ConfigurationError) result = commandFailure(commandName, ExitCode.ConfigurationError, "Configuration is invalid.", error.issues.map((issue) => ({ code: issue.code, message: issue.message })));
    else if (error instanceof MigrationError || error instanceof DatabaseNotReadyError) result = commandFailure(commandName, ExitCode.DataError, "Database is not ready.", [{ code: "database_not_ready", message: error.message }]);
    else if (error instanceof AnalyticalResultContractError || error instanceof RangeError || error instanceof TypeError) result = usageFailure("Invalid rediscovery command arguments.");
    else result = commandFailure(commandName, ExitCode.InternalError, "Rediscovery analysis failed.", [{ code: "internal_error", message: "An unexpected rediscovery analysis error occurred" }]);
  } finally { connection?.close(); }
  const output = result.status === "success" && format === "human" && analysis !== undefined ? renderRediscoveryHuman(analysis) : renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
