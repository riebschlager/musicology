import path from "node:path";

import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import {
  IngestIssueCode,
  IngestIssueSummary,
  type HashedSourceFile,
  type IngestFileCounts,
  type IngestLifecycleOptions,
  type IngestRecordCounts,
  type IngestRunContext,
  type IngestSummary,
  type RecordOutcome,
  type SourceFileRegistration,
} from "./contracts.ts";
import { isSha256 } from "./hashing.ts";

interface SourceFileRow extends SqliteRow {
  readonly byte_size: number;
  readonly content_sha256: string;
  readonly id: number;
  readonly relative_path: string;
  readonly source_type: string;
}

interface MutableCounts {
  files: {
    discovered: number;
    noOp: number;
    registered: number;
    unsupported: number;
  };
  records: {
    accepted: number;
    discovered: number;
    duplicated: number;
    excluded: number;
    rejected: number;
  };
}

export class IngestLifecycleError extends Error {
  readonly code: IngestIssueCode;
  readonly runId?: number;
  readonly safeSummary: string;

  constructor(code: IngestIssueCode, options: { readonly runId?: number } = {}) {
    const safeSummary = IngestIssueSummary[code];
    super(safeSummary);
    this.name = "IngestLifecycleError";
    this.code = code;
    this.safeSummary = safeSummary;
    if (options.runId !== undefined) {
      this.runId = options.runId;
    }
  }
}

function emptyCounts(): MutableCounts {
  return {
    files: { discovered: 0, registered: 0, noOp: 0, unsupported: 0 },
    records: { discovered: 0, accepted: 0, duplicated: 0, excluded: 0, rejected: 0 },
  };
}

function validateNonNegativeEpoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Ingest lifecycle clock must return a non-negative epoch millisecond integer");
  }
  return value;
}

function failureCompletionEpoch(now: () => number, startedAt: number): number {
  try {
    return Math.max(startedAt, validateNonNegativeEpoch(now()));
  } catch {
    return startedAt;
  }
}

function validateRelativePath(relativePath: string): void {
  const segments = relativePath.split("/");
  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath.includes("\\") ||
    relativePath.endsWith("/") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    segments.includes(".") ||
    segments.includes("..") ||
    segments.includes("")
  ) {
    throw new IngestLifecycleError(IngestIssueCode.UnsupportedFile);
  }
}

function registerSourceFile(
  connection: SqliteConnection,
  runId: number,
  file: HashedSourceFile,
): SourceFileRegistration {
  validateRelativePath(file.relativePath);
  if (!Number.isSafeInteger(file.byteSize) || file.byteSize < 0 || !isSha256(file.contentSha256)) {
    throw new IngestLifecycleError(IngestIssueCode.MalformedFile);
  }

  const byPath = connection
    .prepare<SourceFileRow>(
      `SELECT id, relative_path, source_type, byte_size, content_sha256
       FROM source_file
       WHERE relative_path = @relativePath`,
    )
    .get({ relativePath: file.relativePath });
  if (byPath !== undefined && byPath.content_sha256 !== file.contentSha256) {
    throw new IngestLifecycleError(IngestIssueCode.SourceFileChanged);
  }

  const existing =
    byPath ??
    connection
      .prepare<SourceFileRow>(
        `SELECT id, relative_path, source_type, byte_size, content_sha256
         FROM source_file
         WHERE source_type = @sourceType AND content_sha256 = @contentSha256`,
      )
      .get({ contentSha256: file.contentSha256, sourceType: file.sourceType });
  if (existing !== undefined) {
    if (existing.source_type !== file.sourceType || existing.byte_size !== file.byteSize) {
      throw new IngestLifecycleError(IngestIssueCode.MalformedFile);
    }
    connection
      .prepare("UPDATE source_file SET last_ingest_run_id = @runId WHERE id = @sourceFileId")
      .run({ runId, sourceFileId: existing.id });
    return {
      status: "already_registered",
      matchedBy: byPath === undefined ? "content_hash" : "path_and_hash",
      sourceFileId: existing.id,
    };
  }

  const inserted = connection
    .prepare(
      `INSERT INTO source_file
        (relative_path, source_type, byte_size, content_sha256,
         first_ingest_run_id, last_ingest_run_id)
       VALUES
        (@relativePath, @sourceType, @byteSize, @contentSha256, @runId, @runId)`,
    )
    .run({
      byteSize: file.byteSize,
      contentSha256: file.contentSha256,
      relativePath: file.relativePath,
      runId,
      sourceType: file.sourceType,
    });
  return { status: "registered", sourceFileId: Number(inserted.lastInsertRowid) };
}

function recordOutcome(counts: MutableCounts, outcome: RecordOutcome): void {
  counts.records.discovered += 1;
  switch (outcome.kind) {
    case "accepted":
      if (!isSha256(outcome.sourceFingerprintSha256)) {
        throw new Error("Accepted source fingerprint must be a lowercase SHA-256 digest");
      }
      counts.records.accepted += 1;
      break;
    case "duplicate":
      if (!isSha256(outcome.sourceFingerprintSha256)) {
        throw new Error("Duplicate source fingerprint must be a lowercase SHA-256 digest");
      }
      counts.records.accepted += 1;
      counts.records.duplicated += 1;
      break;
    case "excluded":
      counts.records.excluded += 1;
      break;
    case "rejected":
      counts.records.rejected += 1;
      break;
  }
}

function immutableCounts(counts: MutableCounts): {
  files: IngestFileCounts;
  records: IngestRecordCounts;
} {
  return {
    files: { ...counts.files },
    records: { ...counts.records },
  };
}

function updateCompletedRun(
  connection: SqliteConnection,
  runId: number,
  completedAt: number,
  counts: MutableCounts,
): void {
  connection
    .prepare(
      `UPDATE ingest_run
       SET completed_at_epoch_ms = @completedAt,
           status = 'succeeded',
           discovered_file_count = @discoveredFiles,
           registered_file_count = @registeredFiles,
           noop_file_count = @noopFiles,
           discovered_count = @discovered,
           accepted_count = @accepted,
           duplicated_count = @duplicated,
           excluded_count = @excluded,
           rejected_count = @rejected,
           unsupported_count = @unsupported
       WHERE id = @runId AND status = 'running'`,
    )
    .run({
      accepted: counts.records.accepted,
      completedAt,
      discovered: counts.records.discovered,
      discoveredFiles: counts.files.discovered,
      duplicated: counts.records.duplicated,
      excluded: counts.records.excluded,
      noopFiles: counts.files.noOp,
      registeredFiles: counts.files.registered,
      rejected: counts.records.rejected,
      runId,
      unsupported: counts.files.unsupported,
    });
}

function updateFailedRun(
  connection: SqliteConnection,
  runId: number,
  completedAt: number,
  safeSummary: string,
): void {
  connection
    .prepare(
      `UPDATE ingest_run
       SET completed_at_epoch_ms = @completedAt,
           status = 'failed',
           safe_error_summary = @safeSummary
       WHERE id = @runId AND status = 'running'`,
    )
    .run({ completedAt, runId, safeSummary });
}

/**
 * Runs all file registration and evidence writes in one transaction. The running audit row is
 * created first so failure can be retained safely after every partial write has rolled back.
 */
export function runIngestLifecycle(
  options: IngestLifecycleOptions,
  operation: (context: IngestRunContext) => void,
): IngestSummary {
  const now = options.now ?? Date.now;
  const startedAt = validateNonNegativeEpoch(now());
  const insertedRun = options.connection
    .prepare(
      `INSERT INTO ingest_run
        (command_type, started_at_epoch_ms, status, schema_version, rule_version)
       VALUES (@commandType, @startedAt, 'running', @schemaVersion, @ruleVersion)`,
    )
    .run({
      commandType: options.commandType,
      ruleVersion: options.ruleVersion ?? null,
      schemaVersion: options.schemaVersion,
      startedAt,
    });
  const runId = Number(insertedRun.lastInsertRowid);
  const counts = emptyCounts();

  try {
    options.connection.transaction((transactionConnection) => {
      const context: IngestRunContext = {
        connection: transactionConnection,
        runId,
        registerSourceFile(file): SourceFileRegistration {
          counts.files.discovered += 1;
          const registration = registerSourceFile(transactionConnection, runId, file);
          if (registration.status === "registered") {
            counts.files.registered += 1;
          } else {
            counts.files.noOp += 1;
          }
          return registration;
        },
        recordOutcome(outcome): void {
          recordOutcome(counts, outcome);
        },
        recordUnsupportedFile(): void {
          counts.files.discovered += 1;
          counts.files.unsupported += 1;
        },
      };
      operation(context);
      const completedAt = Math.max(startedAt, validateNonNegativeEpoch(now()));
      updateCompletedRun(transactionConnection, runId, completedAt, counts);
      options.afterSuccess?.({ connection: transactionConnection, runId });
    });
  } catch (error) {
    const issue =
      error instanceof IngestLifecycleError
        ? error
        : new IngestLifecycleError(IngestIssueCode.IngestFailed);
    const completedAt = failureCompletionEpoch(now, startedAt);
    updateFailedRun(options.connection, runId, completedAt, issue.safeSummary);
    throw new IngestLifecycleError(issue.code, { runId });
  }

  const finalCounts = immutableCounts(counts);
  return {
    runId,
    commandType: options.commandType,
    status: "succeeded",
    noOp:
      finalCounts.files.registered === 0 &&
      finalCounts.files.unsupported === 0 &&
      finalCounts.records.accepted === 0 &&
      finalCounts.records.excluded === 0 &&
      finalCounts.records.rejected === 0,
    ...finalCounts,
  };
}
