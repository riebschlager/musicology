import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigurationError, loadConfiguration, repositoryRoot } from "../config/config.ts";
import { openSqliteConnection } from "../db/better-sqlite3.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { getMigrationStatus, MigrationError } from "../db/migrations.ts";
import { generateGenreEnrichmentCoverage, genreEnrichmentTargets } from "../genre/coverage.ts";
import { MusicbrainzGenreClient } from "../genre/musicbrainz-client.ts";
import { SqliteGenreEnrichmentSnapshotCache } from "../genre/persistence.ts";
import {
  commandFailure,
  commandSuccess,
  ExitCode,
  renderCommandResult,
  type CommandResult,
  type JsonObject,
  type OutputFormat,
} from "./result.ts";

const commandName = "enrich:genres";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before genre enrichment.");
    this.name = "DatabaseNotReadyError";
  }
}

export interface RunGenreEnrichmentCommandOptions {
  readonly dryRun?: boolean;
  readonly limit?: number;
  readonly refresh?: boolean;
}

export async function runGenreEnrichmentCommand(
  connection: SqliteConnection,
  client: MusicbrainzGenreClient,
  options: RunGenreEnrichmentCommandOptions = {},
): Promise<CommandResult<JsonObject>> {
  const actions = { cached: 0, fetched: 0, skippedAmbiguousIdentity: 0, skippedLimit: 0 };
  const cache = new SqliteGenreEnrichmentSnapshotCache(connection);
  for await (const result of client.enrichArtists(
    genreEnrichmentTargets(connection),
    cache,
    options,
  )) {
    if (result.action === "cached") actions.cached += 1;
    if (result.action === "fetched") actions.fetched += 1;
    if (result.reason === "ambiguous_identity") actions.skippedAmbiguousIdentity += 1;
    if (result.reason === "limit_reached") actions.skippedLimit += 1;
  }
  const coverage = generateGenreEnrichmentCoverage(connection);
  return commandSuccess(
    commandName,
    options.dryRun
      ? "Genre enrichment dry run completed without storing snapshots."
      : "Genre enrichment completed.",
    { actions, coverage: coverage as unknown as JsonObject, dryRun: options.dryRun ?? false },
  );
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message: "Usage: enrich:genres [--json] [--dry-run] [--limit count] [--refresh]",
    },
  ]);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(value)) throw new TypeError("Invalid genre enrichment limit");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) throw new TypeError("Invalid genre enrichment limit");
  return limit;
}

async function main(): Promise<void> {
  let connection: SqliteConnection | undefined;
  let format: OutputFormat = "human";
  let result: CommandResult;
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        limit: { type: "string" },
        refresh: { type: "boolean", default: false },
      },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure("The genre enrichment command does not accept positional arguments.");
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
      connection = openSqliteConnection(configuration.paths.databasePath);
      const status = getMigrationStatus(connection, migrationsDirectory);
      if (status.applied.length === 0 || status.pending.length > 0)
        throw new DatabaseNotReadyError();
      const limit = parseLimit(parsed.values.limit);
      result = await runGenreEnrichmentCommand(connection, new MusicbrainzGenreClient(), {
        dryRun: parsed.values["dry-run"],
        ...(limit === undefined ? {} : { limit }),
        refresh: parsed.values.refresh,
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
    } else if (error instanceof DatabaseNotReadyError || error instanceof MigrationError) {
      result = commandFailure(commandName, ExitCode.DataError, "Database is not ready.", [
        { code: "database_not_ready", message: error.message },
      ]);
    } else if (error instanceof TypeError || error instanceof RangeError) {
      result = usageFailure("Genre enrichment arguments are invalid.");
    } else {
      result = commandFailure(commandName, ExitCode.InternalError, "Genre enrichment failed.", [
        {
          code: "internal_error",
          message: "Genre enrichment failed without retaining provider data.",
        },
      ]);
    }
  } finally {
    connection?.close();
  }
  (result.status === "success" ? process.stdout : process.stderr).write(
    renderCommandResult(result, { format }),
  );
  process.exitCode = result.exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) void main();
