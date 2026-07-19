import { existsSync } from "node:fs";
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
import {
  generateCoverageReport,
  type CoverageReport,
  type SourceCoverage,
} from "../reporting/coverage.ts";
import {
  commandFailure,
  commandSuccess,
  ExitCode,
  type CommandResult,
  type JsonObject,
  type OutputFormat,
  redactSensitiveText,
  renderCommandResult,
} from "./result.ts";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const commandName = "report:coverage";

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before reporting historical evidence coverage");
    this.name = "DatabaseNotReadyError";
  }
}

export interface RunCoverageCommandOptions {
  readonly connection: SqliteConnection;
  readonly timezone: string;
  readonly now?: () => number;
  readonly compareArchiveBaseline?: boolean;
}

export function runCoverageCommand(options: RunCoverageCommandOptions): CommandResult<JsonObject> {
  const report = generateCoverageReport(options);
  return commandSuccess(
    commandName,
    `Coverage report produced for ${report.totals.evidenceOccurrences} source evidence occurrence(s).`,
    report as unknown as JsonObject,
  );
}

function sourceLine(source: SourceCoverage): string {
  const range =
    source.observedRange === null
      ? "no observations"
      : `${source.observedRange.firstObservedAt} to ${source.observedRange.lastObservedAt}`;
  return `${source.source}: ${source.evidenceCount} evidence; ${source.totals.rejected} rejected; ${source.totals.nonMusic} non-music; ${source.duplicates.groupCount} duplicate group(s) / ${source.duplicates.extraEvidenceCount} extra occurrence(s); ${source.longGaps.length} long gap(s); ${range}`;
}

export function renderCoverageHuman(report: CoverageReport): string {
  const lines = [
    `Coverage report ${report.reportVersion} generated at ${report.generatedAt}.`,
    `Timezone: ${report.timezone}. Counts are source evidence occurrences; canonical-event counts are not included.`,
    `Registered input hashes: ${report.inputFiles.length}.`,
    ...report.sources.map(sourceLine),
  ];
  if (report.archiveBaselineComparison !== undefined) {
    lines.push(
      report.archiveBaselineComparison.matches
        ? `Archive baseline ${report.archiveBaselineComparison.version} matches.`
        : `Archive baseline ${report.archiveBaselineComparison.version}: ${report.archiveBaselineComparison.deviations.length} deviation(s).`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function usageFailure(summary: string): CommandResult {
  return commandFailure(commandName, ExitCode.UsageError, summary, [
    {
      code: "invalid_arguments",
      message: "Usage: report:coverage [--json] [--compare-archive-baseline]",
    },
  ]);
}

function main(): void {
  let connection: SqliteConnection | undefined;
  let format: OutputFormat = "human";
  let result: CommandResult<JsonObject> | CommandResult;
  let report: CoverageReport | undefined;
  let sensitiveValues: readonly string[] = [];

  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        "compare-archive-baseline": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      strict: true,
    });
    format = parsed.values.json ? "json" : "human";
    if (parsed.positionals.length > 0) {
      result = usageFailure("The coverage report command does not accept positional arguments.");
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
      report = generateCoverageReport({
        connection,
        timezone: configuration.presentationTimezone,
        compareArchiveBaseline: parsed.values["compare-archive-baseline"],
      });
      result = commandSuccess(
        commandName,
        `Coverage report produced for ${report.totals.evidenceOccurrences} source evidence occurrence(s).`,
        report as unknown as JsonObject,
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
    } else if (error instanceof MigrationError) {
      result = commandFailure(commandName, ExitCode.DataError, "Migration validation failed.", [
        { code: error.code, message: error.message },
      ]);
    } else if (error instanceof DatabaseNotReadyError) {
      result = commandFailure(commandName, ExitCode.DataError, "Database is not ready.", [
        { code: "database_not_ready", message: error.message },
      ]);
    } else if (error instanceof TypeError) {
      result = usageFailure("Invalid coverage report command arguments.");
    } else {
      result = commandFailure(commandName, ExitCode.InternalError, "Coverage reporting failed.", [
        { code: "internal_error", message: "An unexpected coverage reporting error occurred" },
      ]);
    }
  } finally {
    connection?.close();
  }

  const output =
    result.status === "success" && format === "human" && report !== undefined
      ? redactSensitiveText(renderCoverageHuman(report), sensitiveValues)
      : renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
