import type { SqliteConnection } from "../db/connection.ts";
import { persistLastfmApiPages } from "./persistence.ts";
import {
  advanceLastfmSyncCursor,
  type LastfmSyncPlan,
  type LastfmSyncPlanOptions,
  planLastfmSync,
} from "./sync-plan.ts";
import type { LastfmRecentTracksPage, LastfmRecentTracksWindow } from "./client.ts";

/** The narrow fetch boundary required by synchronization orchestration. */
export interface LastfmRecentTracksFetcher {
  getRecentTracksPages(
    window: LastfmRecentTracksWindow,
  ): AsyncGenerator<LastfmRecentTracksPage>;
}

export interface SynchronizeLastfmOptions {
  readonly connection: SqliteConnection;
  readonly dryRun?: boolean;
  readonly fetcher: LastfmRecentTracksFetcher;
  readonly now?: () => number;
  readonly plan: LastfmSyncPlan;
  readonly schemaVersion: string;
  readonly scopeFingerprintSha256: string;
}

export interface LastfmSyncSummary {
  readonly cursorBoundaryEpochMs: number | null;
  readonly cursorUpdatePolicy: LastfmSyncPlan["cursorUpdatePolicy"];
  readonly dryRun: boolean;
  readonly fetched: number;
  readonly ignored: number;
  readonly existing: number;
  readonly inserted: number;
  readonly matched: number;
  readonly pages: number;
  readonly plan: LastfmSyncPlan;
  readonly runId: number | null;
}

/**
 * Fetches every page before opening the evidence transaction. Therefore a transport or response
 * validation failure cannot leave partial API evidence behind. Persistence, reconciliation, and
 * normal cursor advancement share the ingest transaction.
 */
export async function synchronizeLastfm(options: SynchronizeLastfmOptions): Promise<LastfmSyncSummary> {
  const pages: LastfmRecentTracksPage[] = [];
  const window: LastfmRecentTracksWindow = {
    fromEpochMs: options.plan.fromEpochMs,
    ...(options.plan.toEpochMs === undefined ? {} : { toEpochMs: options.plan.toEpochMs }),
  };
  for await (const page of options.fetcher.getRecentTracksPages(window)) pages.push(page);

  const fetched = pages.reduce((total, page) => total + page.completedTracks.length, 0);
  const ignored = pages.reduce((total, page) => total + page.ignoredNowPlayingCount, 0);
  if (options.dryRun ?? false) {
    return {
      cursorBoundaryEpochMs: null,
      cursorUpdatePolicy: options.plan.cursorUpdatePolicy,
      dryRun: true,
      existing: 0,
      fetched,
      ignored,
      inserted: 0,
      matched: 0,
      pages: pages.length,
      plan: options.plan,
      runId: null,
    };
  }

  let cursorBoundaryEpochMs: number | null = null;
  const persisted = persistLastfmApiPages({
    connection: options.connection,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.plan.cursorUpdatePolicy === "advance_on_success"
      ? {
          onSuccessfulRun: ({ connection, runId }) => {
            cursorBoundaryEpochMs = advanceLastfmSyncCursor(connection, {
              boundaryEpochMs: latestCompletedBoundary(options.plan, pages),
              cursorUpdatePolicy: options.plan.cursorUpdatePolicy,
              lastSuccessfulIngestRunId: runId,
              scopeFingerprintSha256: options.scopeFingerprintSha256,
              updatedAtEpochMs: (options.now ?? Date.now)(),
            });
          },
        }
      : {}),
    pages,
    schemaVersion: options.schemaVersion,
  });

  const inserted = persisted.records.accepted - persisted.records.duplicated;
  return {
    cursorBoundaryEpochMs,
    cursorUpdatePolicy: options.plan.cursorUpdatePolicy,
    dryRun: false,
    existing: fetched - inserted,
    fetched,
    ignored,
    inserted,
    matched: persisted.reconciliation.autoAccepted,
    pages: pages.length,
    plan: options.plan,
    runId: persisted.runId,
  };
}

export function prepareLastfmSyncPlan(
  connection: SqliteConnection,
  options: LastfmSyncPlanOptions,
): LastfmSyncPlan {
  return planLastfmSync(connection, options);
}

function latestCompletedBoundary(
  plan: LastfmSyncPlan,
  pages: readonly LastfmRecentTracksPage[],
): number {
  return pages.reduce(
    (boundary, page) =>
      page.completedTracks.reduce(
        (latest, track) => Math.max(latest, track.scrobbledAtEpochMs),
        boundary,
      ),
    plan.fromEpochMs,
  );
}
