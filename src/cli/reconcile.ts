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
import { collapseExactDuplicateEvents, createCanonicalEvents } from "../identity/events.ts";
import { resolveSourceIdentities } from "../identity/resolution.ts";
import { applyReconciliationDecisions } from "../reconciliation/apply.ts";
import { generateCrossSourceCandidates } from "../reconciliation/candidates.ts";
import { calculateCrossSourceMatchFeatures } from "../reconciliation/features.ts";
import { CROSS_SOURCE_DECISION_POLICY } from "../reconciliation/policy.ts";
import {
  commandFailure,
  commandSuccess,
  ExitCode,
  renderCommandResult,
  type CommandResult,
  type JsonObject,
  type OutputFormat,
} from "./result.ts";

const commandName = "reconcile";
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

class DryRunRollback extends Error {}

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before reconciliation.");
    this.name = "DatabaseNotReadyError";
  }
}

export function runReconcileCommand(
  connection: SqliteConnection,
  options: { readonly dryRun?: boolean } = {},
): CommandResult<JsonObject> {
  const dryRun = options.dryRun ?? false;
  let summary: ReturnType<typeof applyReconciliationDecisions> | undefined;
  let pipeline: JsonObject | undefined;
  try {
    connection.transaction(() => {
      const identities = resolveSourceIdentities(connection);
      const events = createCanonicalEvents(connection);
      const duplicates = collapseExactDuplicateEvents(connection);
      const candidates = generateCrossSourceCandidates(connection);
      const features = calculateCrossSourceMatchFeatures(connection);
      summary = applyReconciliationDecisions(connection, { dryRun: false });
      pipeline = {
        candidatePairs: candidates.inserted,
        canonicalEvents: events.processed,
        exactDuplicatesCollapsed:
          duplicates.spotifyEventsCollapsed + duplicates.lastfmEventsCollapsed,
        identitiesResolved: identities.resolved,
        matchFeatures: features.inserted,
      };
      if (dryRun) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  if (summary === undefined || pipeline === undefined) {
    throw new Error("Reconciliation pipeline did not produce a summary");
  }
  return commandSuccess(
    commandName,
    dryRun
      ? "Reconciliation dry run completed without changing canonical data."
      : "Reconciliation decisions applied transactionally.",
    {
      autoAccepted: summary.autoAccepted,
      dryRun,
      ignored: summary.ignored,
      policyRuleVersion: summary.policyRuleVersion,
      pipeline,
      review: summary.review,
      skipped: summary.skipped,
      supersededAutomaticDecisions: summary.supersededAutomaticDecisions,
    },
  );
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message:
        "Usage: reconcile [--json] [--dry-run] [--rule-version cross-source-decision-policy-v1]",
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
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "rule-version": { type: "string" },
      },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure("The reconciliation command does not accept positional arguments.");
    } else if (
      parsed.values["rule-version"] !== undefined &&
      parsed.values["rule-version"] !== CROSS_SOURCE_DECISION_POLICY.version
    ) {
      result = usageFailure("The requested reconciliation policy version is unavailable.");
    } else {
      const configuration = loadConfiguration({ repositoryRoot });
      sensitiveValues = configurationRedactionValues(configuration);
      if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
      connection = openSqliteConnection(configuration.paths.databasePath);
      const status = getMigrationStatus(connection, migrationsDirectory);
      if (status.applied.length === 0 || status.pending.length > 0)
        throw new DatabaseNotReadyError();
      result = runReconcileCommand(connection, { dryRun: parsed.values["dry-run"] });
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
    } else if (error instanceof RangeError || error instanceof TypeError) {
      result = usageFailure("Invalid reconciliation command arguments.");
    } else {
      result = commandFailure(commandName, ExitCode.InternalError, "Reconciliation failed.", [
        { code: "internal_error", message: "An unexpected reconciliation error occurred" },
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
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
