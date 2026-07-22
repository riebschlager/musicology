import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SqliteRow } from "../../../src/db/connection.ts";
import { fingerprintLastfmSyncScope, planLastfmSync } from "../../../src/lastfm/sync-plan.ts";
import { synchronizeLastfm, type LastfmRecentTracksFetcher } from "../../../src/lastfm/sync.ts";
import { runLastfmSyncCommand } from "../../../src/cli/sync-lastfm.ts";
import { buildLastfmScrobbleFixture } from "../../fixtures/lastfm.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

interface CountRow extends SqliteRow {
  readonly count: number;
}

const scopeFingerprintSha256 = fingerprintLastfmSyncScope("synthetic-sync-listener");

function count(workspace: TemporaryTestWorkspace, table: string): number {
  return (
    workspace.connection.prepare<CountRow>(`SELECT count(*) AS count FROM ${table}`).get()?.count ??
    -1
  );
}

function page() {
  const record = buildLastfmScrobbleFixture();
  return {
    completedTracks: [
      {
        albumName: record.album_name,
        artistMusicbrainzId: record.artist_musicbrainz_id,
        artistName: record.artist_name,
        loved: record.loved,
        recordingMusicbrainzId: record.recording_musicbrainz_id,
        releaseMusicbrainzId: record.release_musicbrainz_id,
        scrobbledAtEpochMs: record.timestamp,
        trackName: record.track_name,
      },
    ],
    ignoredNowPlayingCount: 1,
    pagination: { page: 1, perPage: 1, total: 1, totalPages: 1 },
  };
}

function fetcher(pages: readonly ReturnType<typeof page>[]): LastfmRecentTracksFetcher {
  return {
    async *getRecentTracksPages() {
      yield* pages;
    },
  };
}

function sync(
  workspace: TemporaryTestWorkspace,
  target: LastfmRecentTracksFetcher,
  dryRun = false,
) {
  const plan = planLastfmSync(workspace.connection, {
    initialFromEpochMs: 0,
    scopeFingerprintSha256,
  });
  return synchronizeLastfm({
    connection: workspace.connection,
    dryRun,
    fetcher: target,
    now: () => 2_000_000_000_000,
    plan,
    schemaVersion: "11",
    scopeFingerprintSha256,
  });
}

describe("Last.fm synchronization orchestration", () => {
  it("does not persist a yielded page or advance the cursor when a later page request fails", async () => {
    await withTemporaryTestWorkspace(async (workspace) => {
      const failingFetcher: LastfmRecentTracksFetcher = {
        async *getRecentTracksPages() {
          yield page();
          throw new Error("synthetic page failure");
        },
      };
      await assert.rejects(() => sync(workspace, failingFetcher));
      assert.equal(count(workspace, "lastfm_scrobble_source"), 0);
      assert.equal(count(workspace, "sync_cursor"), 0);
    });
  });

  it("rolls back insert and reconciliation failures without advancing the cursor", async () => {
    await withTemporaryTestWorkspace(async (workspace) => {
      workspace.connection.execute(`
        CREATE TRIGGER fail_sync_insert BEFORE INSERT ON lastfm_scrobble_source
        BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END;
      `);
      await assert.rejects(() => sync(workspace, fetcher([page()])));
      assert.equal(count(workspace, "lastfm_scrobble_source"), 0);
      assert.equal(count(workspace, "sync_cursor"), 0);
    });

    await withTemporaryTestWorkspace(async (workspace) => {
      workspace.connection.execute(`
        CREATE TRIGGER fail_sync_reconciliation BEFORE INSERT ON listening_event
        BEGIN SELECT RAISE(ABORT, 'synthetic reconciliation failure'); END;
      `);
      await assert.rejects(() => sync(workspace, fetcher([page()])));
      assert.equal(count(workspace, "lastfm_scrobble_source"), 0);
      assert.equal(count(workspace, "sync_cursor"), 0);
    });
  });

  it("rolls back evidence and records a failed run when cursor advancement fails", async () => {
    await withTemporaryTestWorkspace(async (workspace) => {
      workspace.connection.execute(`
        CREATE TRIGGER fail_sync_cursor BEFORE INSERT ON sync_cursor
        BEGIN SELECT RAISE(ABORT, 'synthetic cursor failure'); END;
      `);
      await assert.rejects(() => sync(workspace, fetcher([page()])));
      assert.equal(count(workspace, "lastfm_scrobble_source"), 0);
      assert.equal(count(workspace, "sync_cursor"), 0);
      assert.equal(
        workspace.connection
          .prepare<{ readonly status: string }>(
            "SELECT status FROM ingest_run WHERE command_type = 'lastfm_api_sync'",
          )
          .get()?.status,
        "failed",
      );
    });
  });

  it("dry-runs validated pages without writing evidence, runs, or cursors", async () => {
    await withTemporaryTestWorkspace(async (workspace) => {
      const summary = await sync(workspace, fetcher([page()]), true);
      assert.deepEqual(
        {
          fetched: summary.fetched,
          ignored: summary.ignored,
          inserted: summary.inserted,
          runId: summary.runId,
        },
        { fetched: 1, ignored: 1, inserted: 0, runId: null },
      );
      assert.equal(count(workspace, "ingest_run"), 0);
      assert.equal(count(workspace, "lastfm_scrobble_source"), 0);
      assert.equal(count(workspace, "sync_cursor"), 0);
    });
  });

  it("advances only after success and reports a repeated safety-overlap fetch as existing", async () => {
    await withTemporaryTestWorkspace(async (workspace) => {
      const first = await sync(workspace, fetcher([page()]));
      assert.deepEqual(
        {
          existing: first.existing,
          fetched: first.fetched,
          ignored: first.ignored,
          inserted: first.inserted,
          matched: first.matched,
        },
        { existing: 0, fetched: 1, ignored: 1, inserted: 1, matched: 0 },
      );
      const [firstTrack] = page().completedTracks;
      assert.ok(firstTrack);
      assert.equal(first.cursorBoundaryEpochMs, firstTrack.scrobbledAtEpochMs);
      assert.equal(count(workspace, "sync_cursor"), 1);

      const repeated = await synchronizeLastfm({
        connection: workspace.connection,
        fetcher: fetcher([page()]),
        now: () => 2_000_000_000_000,
        plan: planLastfmSync(workspace.connection, { scopeFingerprintSha256 }),
        schemaVersion: "11",
        scopeFingerprintSha256,
      });
      assert.deepEqual(
        { existing: repeated.existing, fetched: repeated.fetched, inserted: repeated.inserted },
        { existing: 1, fetched: 1, inserted: 0 },
      );
      assert.equal(count(workspace, "lastfm_scrobble_source"), 1);
      assert.equal(count(workspace, "sync_cursor"), 1);
    });
  });

  it("returns an aggregate command result with its recovery window", async () => {
    await withTemporaryTestWorkspace(async (workspace) => {
      const result = await runLastfmSyncCommand(
        workspace.connection,
        fetcher([page()]),
        "synthetic-sync-listener",
        "11",
        { dryRun: true, fromEpochMs: 0, toEpochMs: 2_000_000_000_000 },
      );
      assert.equal(result.status, "success");
      assert.deepEqual(result.data, {
        cursorBoundaryEpochMs: null,
        cursorUpdatePolicy: "preserve",
        dryRun: true,
        existing: 0,
        fetched: 1,
        ignored: 1,
        inserted: 0,
        matched: 0,
        pages: 1,
        runId: null,
        window: {
          cursorUpdatePolicy: "preserve",
          fromEpochMs: 0,
          source: "override",
          toEpochMs: 2_000_000_000_000,
        },
      });
    });
  });
});
