import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

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
  ANALYTICAL_EXPORT_DIRECTORY_NAME,
  AnalyticalExportError,
  verifyAnalyticalExports,
} from "../exports/analytics.ts";
import { loadPrivateAnalyticalBundle, PrivateBundleError } from "../publication/private-bundle.ts";
import {
  PublicationProjectionError,
  type PublicationProjectionInput,
  projectPublicSnapshot,
} from "../publication/projection.ts";
import {
  activateApprovedPublicSnapshot,
  approvePublicCandidate,
  buildPublicCandidate,
  PublicationWorkflowError,
  readActivePublicSnapshot,
  readStoredPublicSnapshot,
  writePublicCandidate,
} from "../publication/workflow.ts";
import {
  type CommandResult,
  commandFailure,
  commandSuccess,
  ExitCode,
  type JsonObject,
  type OutputFormat,
  renderCommandResult,
} from "./result.ts";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const snapshotIdPattern = /^snapshot-\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

type PublicationAction = "activate" | "approve" | "generate" | "review";

class PublicationCommandUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationCommandUsageError";
  }
}

class DatabaseNotReadyError extends Error {
  constructor() {
    super("Database migrations must be current before generating a publication candidate");
    this.name = "DatabaseNotReadyError";
  }
}

function main(): void {
  let connection: SqliteConnection | undefined;
  let format: OutputFormat = "human";
  let sensitiveValues: readonly string[] = [];
  let result: CommandResult<JsonObject> | CommandResult;
  const action = process.argv[2];
  const commandName = isPublicationAction(action) ? `publication:${action}` : "publication";

  try {
    if (!isPublicationAction(action)) {
      throw new PublicationCommandUsageError("A publication action is required");
    }
    const configuration = loadConfiguration({ repositoryRoot });
    sensitiveValues = configurationRedactionValues(configuration);
    const publicationDirectory = configuration.paths.publicationDirectory;
    const args = process.argv.slice(3);

    if (action === "generate") {
      const parsed = parseArgs({
        args,
        allowPositionals: false,
        options: {
          "generated-on": { type: "string" },
          input: { type: "string" },
          json: { type: "boolean", default: false },
        },
        strict: true,
      });
      format = parsed.values.json ? "json" : "human";
      const inputPath = requiredString(parsed.values.input, "--input");
      const generatedOn = requiredString(parsed.values["generated-on"], "--generated-on");
      if (!existsSync(configuration.paths.databasePath)) throw new DatabaseNotReadyError();
      connection = openReadonlySqliteConnection(configuration.paths.databasePath);
      const status = getMigrationStatus(connection, migrationsDirectory);
      if (status.applied.length === 0 || status.pending.length > 0) {
        throw new DatabaseNotReadyError();
      }
      const analyticalOptions = {
        connection,
        migrationsDirectory,
        presentationTimezone: configuration.presentationTimezone,
      };
      const analyticalManifest = verifyAnalyticalExports(
        configuration.paths.outputsDirectory,
        analyticalOptions,
      );
      const privateBundle = loadPrivateAnalyticalBundle(
        path.join(configuration.paths.outputsDirectory, ANALYTICAL_EXPORT_DIRECTORY_NAME),
        analyticalManifest.databaseState,
      );
      const input = readPublicationInput(inputPath);
      const projection = projectPublicSnapshot(privateBundle, input);
      const previousDirectory = activeApprovedDirectory(publicationDirectory);
      const candidate = buildPublicCandidate(projection, generatedOn, previousDirectory);
      writePublicCandidate(
        path.join(configuration.paths.outputsDirectory, "publication-candidates"),
        candidate,
      );
      result = commandSuccess(
        commandName,
        `Generated publication candidate ${candidate.manifest.snapshotId}. Review report ${candidate.manifest.reportSha256}.`,
        publicationSummary(candidate),
      );
    } else if (action === "review") {
      const parsed = parseSnapshotArgs(args);
      format = parsed.format;
      const candidate = readStoredPublicSnapshot(
        path.join(
          configuration.paths.outputsDirectory,
          "publication-candidates",
          parsed.snapshotId,
        ),
      );
      if (candidate.manifest.state !== "candidate") {
        throw new PublicationWorkflowError(
          "candidate_invalid",
          "Only a candidate snapshot can be reviewed",
        );
      }
      result = commandSuccess(
        commandName,
        `Validated publication candidate ${candidate.manifest.snapshotId}. Review the exact report and artifact bytes before approval.`,
        publicationSummary(candidate),
      );
    } else if (action === "approve") {
      const parsed = parseArgs({
        args,
        allowPositionals: false,
        options: {
          "decided-on": { type: "string" },
          json: { type: "boolean", default: false },
          "report-sha256": { type: "string" },
          snapshot: { type: "string" },
        },
        strict: true,
      });
      format = parsed.values.json ? "json" : "human";
      const snapshotId = requiredSnapshotId(parsed.values.snapshot);
      const decidedOn = requiredString(parsed.values["decided-on"], "--decided-on");
      const reviewedReportSha256 = requiredSha256(parsed.values["report-sha256"]);
      const candidateDirectory = path.join(
        configuration.paths.outputsDirectory,
        "publication-candidates",
        snapshotId,
      );
      const approvedDirectory = approvePublicCandidate(
        candidateDirectory,
        publicationDirectory,
        decidedOn,
        reviewedReportSha256,
      );
      const approved = readStoredPublicSnapshot(approvedDirectory);
      result = commandSuccess(
        commandName,
        `Approved publication snapshot ${approved.manifest.snapshotId}. It is immutable but not active until publication:activate is run.`,
        publicationSummary(approved),
      );
    } else {
      const parsed = parseSnapshotArgs(args);
      format = parsed.format;
      activateApprovedPublicSnapshot(publicationDirectory, parsed.snapshotId);
      const active = readActivePublicSnapshot(publicationDirectory);
      result = commandSuccess(
        commandName,
        `Activated approved publication snapshot ${active.snapshotId}. Commit the approved snapshot and active pointer before deployment.`,
        {
          manifestSha256: active.manifestSha256,
          snapshotId: active.snapshotId,
          snapshotSha256: active.snapshotSha256,
        },
      );
    }
  } catch (error) {
    if (error instanceof PublicationCommandUsageError || error instanceof TypeError) {
      result = usageFailure(commandName);
    } else if (error instanceof ConfigurationError) {
      result = commandFailure(
        commandName,
        ExitCode.ConfigurationError,
        "Configuration is invalid.",
        error.issues,
      );
    } else if (error instanceof MigrationError || error instanceof DatabaseNotReadyError) {
      result = commandFailure(commandName, ExitCode.DataError, "Database is not ready.", [
        { code: "database_not_ready", message: error.message },
      ]);
    } else if (
      error instanceof AnalyticalExportError ||
      error instanceof PrivateBundleError ||
      error instanceof PublicationProjectionError ||
      error instanceof PublicationWorkflowError
    ) {
      result = commandFailure(commandName, ExitCode.DataError, "Publication validation failed.", [
        { code: error.code, message: error.message },
      ]);
    } else {
      result = commandFailure(commandName, ExitCode.InternalError, "Publication command failed.", [
        { code: "internal_error", message: "An unexpected publication error occurred" },
      ]);
    }
  } finally {
    connection?.close();
  }

  const output = renderCommandResult(result, { format, sensitiveValues });
  (result.status === "success" ? process.stdout : process.stderr).write(output);
  process.exitCode = result.exitCode;
}

function readPublicationInput(inputPath: string): PublicationProjectionInput {
  try {
    return JSON.parse(readFileSync(inputPath, "utf8")) as PublicationProjectionInput;
  } catch (error) {
    throw new PublicationProjectionError(
      "invalid_editorial_input",
      error instanceof SyntaxError
        ? "Publication input is not valid JSON"
        : "Publication input file could not be read",
    );
  }
}

function parseSnapshotArgs(args: readonly string[]): {
  readonly format: OutputFormat;
  readonly snapshotId: string;
} {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      json: { type: "boolean", default: false },
      snapshot: { type: "string" },
    },
    strict: true,
  });
  return {
    format: parsed.values.json ? "json" : "human",
    snapshotId: requiredSnapshotId(parsed.values.snapshot),
  };
}

function activeApprovedDirectory(publicationDirectory: string): string | undefined {
  if (!existsSync(path.join(publicationDirectory, "active.json"))) return undefined;
  const active = readActivePublicSnapshot(publicationDirectory);
  return path.join(publicationDirectory, "approved", active.snapshotId);
}

function publicationSummary(snapshot: ReturnType<typeof readStoredPublicSnapshot>): JsonObject {
  return {
    artifacts: snapshot.report.artifactSummaries.map((artifact) => ({
      artifact: artifact.artifact,
      recordCount: artifact.recordCount,
      sha256: artifact.sha256,
    })),
    asOfDate: snapshot.report.asOfDate,
    changeSummary: snapshot.report.changeSummary,
    generatedOn: snapshot.report.generatedOn,
    previousSnapshotId: snapshot.report.previousSnapshotId,
    publicationDate: snapshot.manifest.publicationDate,
    reportSha256: snapshot.manifest.reportSha256,
    snapshotId: snapshot.manifest.snapshotId,
    snapshotSha256: snapshot.manifest.snapshotSha256,
    state: snapshot.manifest.state,
  } as JsonObject;
}

function requiredString(value: string | undefined, option: string): string {
  if (value === undefined || value.trim() === "") {
    throw new PublicationCommandUsageError(`${option} is required`);
  }
  return value;
}

function requiredSnapshotId(value: string | undefined): string {
  const snapshotId = requiredString(value, "--snapshot");
  if (!snapshotIdPattern.test(snapshotId)) {
    throw new PublicationCommandUsageError("--snapshot must be a stable public snapshot ID");
  }
  return snapshotId;
}

function requiredSha256(value: string | undefined): string {
  const sha256 = requiredString(value, "--report-sha256");
  if (!sha256Pattern.test(sha256)) {
    throw new PublicationCommandUsageError("--report-sha256 must be a lowercase SHA-256 digest");
  }
  return sha256;
}

function isPublicationAction(value: string | undefined): value is PublicationAction {
  return value === "activate" || value === "approve" || value === "generate" || value === "review";
}

function usageFailure(commandName: string): CommandResult {
  return commandFailure(
    commandName,
    ExitCode.UsageError,
    "Invalid publication command arguments.",
    [
      {
        code: "invalid_arguments",
        message:
          "Usage: publication generate --input <file> --generated-on <YYYY-MM-DD> [--json] | publication review --snapshot <id> [--json] | publication approve --snapshot <id> --decided-on <YYYY-MM-DD> --report-sha256 <sha256> [--json] | publication activate --snapshot <id> [--json]",
      },
    ],
  );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
