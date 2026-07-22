import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

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
import { LastfmClient, LastfmClientError } from "../lastfm/client.ts";
import {
  LastfmSyncPlanError,
  fingerprintLastfmSyncScope,
  lastfmSyncDryRunWindow,
  planLastfmSync,
} from "../lastfm/sync-plan.ts";
import { synchronizeLastfm } from "../lastfm/sync.ts";
import type { LastfmRecentTracksFetcher } from "../lastfm/sync.ts";
import {
  commandFailure,
  commandSuccess,
  ExitCode,
  renderCommandResult,
  type CommandResult,
  type JsonObject,
  type OutputFormat,
} from "./result.ts";

const commandName = "sync:lastfm";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before Last.fm synchronization.");
    this.name = "DatabaseNotReadyError";
  }
}

class LastfmConfigurationRequiredError extends Error {
  constructor() {
    super("Last.fm synchronization requires both configured credentials.");
    this.name = "LastfmConfigurationRequiredError";
  }
}

interface SyncCommandOptions {
  readonly dryRun: boolean;
  readonly fromEpochMs?: number;
  readonly initialFromEpochMs?: number;
  readonly safetyOverlapMs?: number;
  readonly toEpochMs?: number;
}

export async function runLastfmSyncCommand(
  connection: SqliteConnection,
  client: LastfmRecentTracksFetcher,
  username: string,
  schemaVersion: string,
  options: SyncCommandOptions,
): Promise<CommandResult<JsonObject>> {
  const scopeFingerprintSha256 = fingerprintLastfmSyncScope(username);
  const plan = planLastfmSync(connection, {
    ...(options.fromEpochMs === undefined ? {} : { fromEpochMs: options.fromEpochMs }),
    ...(options.initialFromEpochMs === undefined
      ? {}
      : { initialFromEpochMs: options.initialFromEpochMs }),
    ...(options.safetyOverlapMs === undefined ? {} : { safetyOverlapMs: options.safetyOverlapMs }),
    scopeFingerprintSha256,
    ...(options.toEpochMs === undefined ? {} : { toEpochMs: options.toEpochMs }),
  });
  const summary = await synchronizeLastfm({
    connection,
    dryRun: options.dryRun,
    fetcher: client,
    plan,
    schemaVersion,
    scopeFingerprintSha256,
  });
  return commandSuccess(
    commandName,
    options.dryRun
      ? "Last.fm synchronization dry run completed without persisting evidence or cursor state."
      : "Last.fm synchronization completed atomically.",
    {
      cursorBoundaryEpochMs: summary.cursorBoundaryEpochMs,
      cursorUpdatePolicy: summary.cursorUpdatePolicy,
      dryRun: summary.dryRun,
      existing: summary.existing,
      fetched: summary.fetched,
      ignored: summary.ignored,
      inserted: summary.inserted,
      matched: summary.matched,
      pages: summary.pages,
      runId: summary.runId,
      window: lastfmSyncDryRunWindow(summary.plan),
    },
  );
}

function parseEpoch(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new TypeError("Invalid epoch boundary");
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch)) throw new TypeError("Invalid epoch boundary");
  return epoch;
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message:
        "Usage: sync:lastfm [--json] [--dry-run] [--from epoch-ms] [--to epoch-ms] [--initial-from epoch-ms] [--safety-overlap-ms milliseconds]",
    },
  ]);
}

async function main(): Promise<void> {
  let connection: SqliteConnection | undefined;
  let format: OutputFormat = "human";
  let result: CommandResult;
  let sensitiveValues: readonly string[] = [];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean", default: false },
        from: { type: "string" },
        "initial-from": { type: "string" },
        json: { type: "boolean", default: false },
        "safety-overlap-ms": { type: "string" },
        to: { type: "string" },
      },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure(
        "The Last.fm synchronization command does not accept positional arguments.",
      );
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      if (
        configuration.lastfm.apiKey === undefined ||
        configuration.lastfm.username === undefined
      ) {
        throw new LastfmConfigurationRequiredError();
      }
      if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
      connection = openSqliteConnection(configuration.paths.databasePath);
      const status = getMigrationStatus(connection, migrationsDirectory);
      const currentMigration = status.applied.at(-1);
      if (currentMigration === undefined || status.pending.length > 0)
        throw new DatabaseNotReadyError();
      result = await runLastfmSyncCommand(
        connection,
        new LastfmClient({
          apiKey: configuration.lastfm.apiKey,
          username: configuration.lastfm.username,
        }),
        configuration.lastfm.username,
        String(currentMigration.version),
        {
          dryRun: parsed.values["dry-run"],
          fromEpochMs: parseEpoch(parsed.values.from),
          initialFromEpochMs: parseEpoch(parsed.values["initial-from"]),
          safetyOverlapMs: parseEpoch(parsed.values["safety-overlap-ms"]),
          toEpochMs: parseEpoch(parsed.values.to),
        },
      );
    }
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof LastfmConfigurationRequiredError) {
      result = commandFailure(
        commandName,
        ExitCode.ConfigurationError,
        "Configuration is invalid.",
        [
          {
            code:
              error instanceof LastfmConfigurationRequiredError
                ? "lastfm_credentials_required"
                : "configuration_invalid",
            message:
              error instanceof LastfmConfigurationRequiredError
                ? error.message
                : "Configuration values are invalid.",
          },
        ],
      );
    } else if (
      error instanceof LastfmSyncPlanError ||
      error instanceof TypeError ||
      error instanceof RangeError
    ) {
      result = usageFailure("Last.fm synchronization arguments are invalid.");
    } else if (error instanceof MigrationError || error instanceof DatabaseNotReadyError) {
      result = commandFailure(commandName, ExitCode.DataError, "Database is not ready.", [
        { code: "database_not_ready", message: error.message },
      ]);
    } else if (error instanceof LastfmClientError) {
      result = commandFailure(commandName, ExitCode.DataError, "Last.fm synchronization failed.", [
        { code: error.category, message: error.message },
      ]);
    } else if (error instanceof IngestLifecycleError) {
      result = commandFailure(commandName, ExitCode.DataError, "Last.fm synchronization failed.", [
        { code: error.code, message: error.safeSummary },
      ]);
    } else {
      result = commandFailure(
        commandName,
        ExitCode.InternalError,
        "Last.fm synchronization failed.",
        [{ code: "internal_error", message: "An unexpected synchronization error occurred" }],
      );
    }
  } finally {
    connection?.close();
  }
  const output = renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) void main();
