import { createHash } from "node:crypto";

import type { SqliteConnection, SqliteRow } from "../db/connection.ts";

export const DEFAULT_LASTFM_SAFETY_OVERLAP_MS = 5 * 60 * 1_000;

export const LastfmCursorUpdatePolicy = {
  AdvanceOnSuccess: "advance_on_success",
  Preserve: "preserve",
} as const;

export type LastfmCursorUpdatePolicy =
  (typeof LastfmCursorUpdatePolicy)[keyof typeof LastfmCursorUpdatePolicy];

export interface LastfmSyncPlanOptions {
  /** A recovery override. Any explicit boundary preserves the normal incremental cursor. */
  readonly fromEpochMs?: number;
  /** A recovery override. Any explicit boundary preserves the normal incremental cursor. */
  readonly toEpochMs?: number;
  /** Required only when there is neither a cursor nor imported Last.fm evidence. */
  readonly initialFromEpochMs?: number;
  readonly safetyOverlapMs?: number;
  readonly scopeFingerprintSha256: string;
}

export interface LastfmSyncPlan {
  readonly cursorBoundaryEpochMs?: number;
  readonly cursorUpdatePolicy: LastfmCursorUpdatePolicy;
  readonly fromEpochMs: number;
  readonly source: "cursor" | "initial_boundary" | "latest_evidence" | "override";
  readonly toEpochMs?: number;
}

export interface LastfmSyncDryRunWindow {
  readonly cursorUpdatePolicy: LastfmCursorUpdatePolicy;
  readonly fromEpochMs: number;
  readonly source: LastfmSyncPlan["source"];
  readonly toEpochMs: number | null;
}

export const LastfmSyncPlanErrorCode = {
  InitialBoundaryRequired: "initial_boundary_required",
  InvalidBounds: "invalid_bounds",
  InvalidCursor: "invalid_cursor",
  InvalidScope: "invalid_scope",
} as const;

export type LastfmSyncPlanErrorCode =
  (typeof LastfmSyncPlanErrorCode)[keyof typeof LastfmSyncPlanErrorCode];

/** A safe planning error: it never contains account text or request parameters. */
export class LastfmSyncPlanError extends Error {
  readonly code: LastfmSyncPlanErrorCode;

  constructor(code: LastfmSyncPlanErrorCode) {
    super(lastfmSyncPlanErrorSummary(code));
    this.name = "LastfmSyncPlanError";
    this.code = code;
  }
}

interface CursorRow extends SqliteRow {
  readonly boundary_epoch_ms: number;
}

interface LatestEvidenceRow extends SqliteRow {
  readonly boundary_epoch_ms: number | null;
}

interface SuccessfulRunRow extends SqliteRow {
  readonly found: number;
}

/** Creates a one-way cursor scope key without persisting the configured Last.fm username. */
export function fingerprintLastfmSyncScope(username: string): string {
  if (!isNonBlankSafeText(username)) {
    throw new LastfmSyncPlanError(LastfmSyncPlanErrorCode.InvalidScope);
  }
  return createHash("sha256").update("lastfm-sync-scope-v1\0").update(username).digest("hex");
}

/** Plans an inclusive UTC request window without changing any cursor state. */
export function planLastfmSync(
  connection: SqliteConnection,
  options: LastfmSyncPlanOptions,
): LastfmSyncPlan {
  validateScopeFingerprint(options.scopeFingerprintSha256);
  const safetyOverlapMs = options.safetyOverlapMs ?? DEFAULT_LASTFM_SAFETY_OVERLAP_MS;
  if (!isNonNegativeSafeInteger(safetyOverlapMs)) {
    throw new LastfmSyncPlanError(LastfmSyncPlanErrorCode.InvalidBounds);
  }
  validateOptionalEpoch(options.fromEpochMs);
  validateOptionalEpoch(options.toEpochMs);
  validateOptionalEpoch(options.initialFromEpochMs);

  const hasOverride = options.fromEpochMs !== undefined || options.toEpochMs !== undefined;
  const cursor = readCursor(connection, options.scopeFingerprintSha256);
  let source: LastfmSyncPlan["source"];
  let fromEpochMs: number;

  if (options.fromEpochMs !== undefined) {
    fromEpochMs = options.fromEpochMs;
    source = "override";
  } else if (cursor !== undefined) {
    fromEpochMs = Math.max(0, cursor - safetyOverlapMs);
    source = "cursor";
  } else {
    if (options.initialFromEpochMs !== undefined) {
      fromEpochMs = options.initialFromEpochMs;
      source = "initial_boundary";
    } else {
      const latestEvidence = readLatestLastfmEvidence(connection);
      if (latestEvidence !== undefined) {
        fromEpochMs = Math.max(0, latestEvidence - safetyOverlapMs);
        source = "latest_evidence";
      } else {
        throw new LastfmSyncPlanError(LastfmSyncPlanErrorCode.InitialBoundaryRequired);
      }
    }
  }

  if (options.toEpochMs !== undefined && options.toEpochMs < fromEpochMs) {
    throw new LastfmSyncPlanError(LastfmSyncPlanErrorCode.InvalidBounds);
  }

  return {
    ...(cursor === undefined ? {} : { cursorBoundaryEpochMs: cursor }),
    cursorUpdatePolicy: hasOverride
      ? LastfmCursorUpdatePolicy.Preserve
      : LastfmCursorUpdatePolicy.AdvanceOnSuccess,
    fromEpochMs,
    source,
    ...(options.toEpochMs === undefined ? {} : { toEpochMs: options.toEpochMs }),
  };
}

/** The safe, structured window that P3-06's dry-run command will expose. */
export function lastfmSyncDryRunWindow(plan: LastfmSyncPlan): LastfmSyncDryRunWindow {
  return {
    cursorUpdatePolicy: plan.cursorUpdatePolicy,
    fromEpochMs: plan.fromEpochMs,
    source: plan.source,
    toEpochMs: plan.toEpochMs ?? null,
  };
}

/**
 * Records a completed normal-sync boundary without allowing a cursor regression. P3-06 owns the
 * surrounding transaction and calls this only after fetching, persistence, and reconciliation.
 */
export function advanceLastfmSyncCursor(
  connection: SqliteConnection,
  options: {
    readonly boundaryEpochMs: number;
    readonly cursorUpdatePolicy: LastfmCursorUpdatePolicy;
    readonly lastSuccessfulIngestRunId: number;
    readonly scopeFingerprintSha256: string;
    readonly updatedAtEpochMs: number;
  },
): number {
  validateScopeFingerprint(options.scopeFingerprintSha256);
  if (
    options.cursorUpdatePolicy !== LastfmCursorUpdatePolicy.AdvanceOnSuccess ||
    !isNonNegativeSafeInteger(options.boundaryEpochMs) ||
    !isPositiveSafeInteger(options.lastSuccessfulIngestRunId) ||
    !isNonNegativeSafeInteger(options.updatedAtEpochMs) ||
    options.updatedAtEpochMs < options.boundaryEpochMs
  ) {
    throw new LastfmSyncPlanError(LastfmSyncPlanErrorCode.InvalidCursor);
  }
  const successfulRun = connection
    .prepare<SuccessfulRunRow>(
      `SELECT 1 AS found
       FROM ingest_run
       WHERE id = ? AND command_type = 'lastfm_api_sync' AND status = 'succeeded'`,
    )
    .get([options.lastSuccessfulIngestRunId]);
  if (successfulRun?.found !== 1) {
    throw new LastfmSyncPlanError(LastfmSyncPlanErrorCode.InvalidCursor);
  }

  connection
    .prepare(
      `INSERT INTO sync_cursor
        (source_type, scope_fingerprint_sha256, boundary_epoch_ms, updated_at_epoch_ms,
         last_successful_ingest_run_id)
       VALUES ('lastfm_api', @scopeFingerprintSha256, @boundaryEpochMs, @updatedAtEpochMs,
               @lastSuccessfulIngestRunId)
       ON CONFLICT (source_type, scope_fingerprint_sha256) DO UPDATE SET
         boundary_epoch_ms = excluded.boundary_epoch_ms,
         updated_at_epoch_ms = excluded.updated_at_epoch_ms,
         last_successful_ingest_run_id = excluded.last_successful_ingest_run_id
       WHERE excluded.boundary_epoch_ms >= sync_cursor.boundary_epoch_ms`,
    )
    .run(options);

  const boundary = readCursor(connection, options.scopeFingerprintSha256);
  if (boundary === undefined) throw new LastfmSyncPlanError(LastfmSyncPlanErrorCode.InvalidCursor);
  return boundary;
}

function readCursor(
  connection: SqliteConnection,
  scopeFingerprintSha256: string,
): number | undefined {
  return connection
    .prepare<CursorRow>(
      `SELECT boundary_epoch_ms
       FROM sync_cursor
       WHERE source_type = 'lastfm_api' AND scope_fingerprint_sha256 = ?`,
    )
    .get([scopeFingerprintSha256])?.boundary_epoch_ms;
}

function readLatestLastfmEvidence(connection: SqliteConnection): number | undefined {
  const boundary = connection
    .prepare<LatestEvidenceRow>(
      "SELECT max(scrobbled_at_epoch_ms) AS boundary_epoch_ms FROM lastfm_scrobble_source",
    )
    .get()?.boundary_epoch_ms;
  return boundary ?? undefined;
}

function validateScopeFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new LastfmSyncPlanError(LastfmSyncPlanErrorCode.InvalidScope);
  }
}

function validateOptionalEpoch(value: number | undefined): void {
  if (value !== undefined && !isNonNegativeSafeInteger(value)) {
    throw new LastfmSyncPlanError(LastfmSyncPlanErrorCode.InvalidBounds);
  }
}

function isNonBlankSafeText(value: string): boolean {
  return value.trim() !== "" && !/\p{Cc}/u.test(value);
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function lastfmSyncPlanErrorSummary(code: LastfmSyncPlanErrorCode): string {
  switch (code) {
    case LastfmSyncPlanErrorCode.InitialBoundaryRequired:
      return "An initial Last.fm sync boundary is required";
    case LastfmSyncPlanErrorCode.InvalidBounds:
      return "Last.fm sync boundaries are invalid";
    case LastfmSyncPlanErrorCode.InvalidCursor:
      return "Last.fm sync cursor state is invalid";
    case LastfmSyncPlanErrorCode.InvalidScope:
      return "Last.fm sync scope is invalid";
  }
}
