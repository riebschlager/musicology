import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SqliteRow } from "../../../src/db/connection.ts";
import { IngestIssueCode } from "../../../src/importers/contracts.ts";
import { importLastfmExportFiles } from "../../../src/importers/lastfm-export/index.ts";
import { IngestLifecycleError } from "../../../src/importers/lifecycle.ts";
import { persistLastfmApiPages } from "../../../src/lastfm/persistence.ts";
import { validateEvidenceLayer } from "../../../src/validation/evidence.ts";
import { buildLastfmScrobbleFixture } from "../../fixtures/lastfm.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

interface CountRow extends SqliteRow {
  readonly count: number;
}

interface OccurrenceRow extends SqliteRow {
  readonly evidence_source_record_id: number;
  readonly source_origin: string;
}

interface EventRow extends SqliteRow {
  readonly event_status: "current" | "unresolved";
  readonly source_count: number;
}

interface ApiInterpretationRow extends EventRow {
  readonly evidence_origin: "api";
  readonly occurrence_origin: "api";
  readonly resolution_kind: "new_unresolved";
}

interface FailedRunRow extends SqliteRow {
  readonly safe_error_summary: string;
  readonly status: "failed";
}

function count(workspace: TemporaryTestWorkspace, table: string): number {
  return (
    workspace.connection.prepare<CountRow>(`SELECT count(*) AS count FROM ${table}`).get()?.count ??
    -1
  );
}

function apiPage(track: ReturnType<typeof apiTrack> | undefined, ignoredNowPlayingCount = 0) {
  return {
    completedTracks: track === undefined ? [] : [track],
    ignoredNowPlayingCount,
    pagination: { page: 1, perPage: 1, total: track === undefined ? 0 : 1, totalPages: 1 },
  };
}

function apiTrack(overrides: Record<string, unknown> = {}) {
  const record = buildLastfmScrobbleFixture(overrides);
  return {
    albumName: record.album_name,
    artistMusicbrainzId: record.artist_musicbrainz_id,
    artistName: record.artist_name,
    loved: record.loved,
    recordingMusicbrainzId: record.recording_musicbrainz_id,
    releaseMusicbrainzId: record.release_musicbrainz_id,
    scrobbledAtEpochMs: record.timestamp,
    trackName: record.track_name,
  };
}

function persist(workspace: TemporaryTestWorkspace, pages: readonly ReturnType<typeof apiPage>[]) {
  return persistLastfmApiPages({
    connection: workspace.connection,
    now: () => 20_000,
    pages,
    schemaVersion: "11",
  });
}

describe("Last.fm API evidence persistence", () => {
  it("gives a new API scrobble an explicit unresolved canonical interpretation", () => {
    withTemporaryTestWorkspace((workspace) => {
      const summary = persist(workspace, [
        apiPage(
          apiTrack({
            artist_musicbrainz_id: null,
            recording_musicbrainz_id: null,
            release_musicbrainz_id: null,
          }),
        ),
      ]);

      assert.deepEqual(summary.records, {
        accepted: 1,
        discovered: 1,
        duplicated: 0,
        excluded: 0,
        rejected: 0,
      });
      assert.equal(count(workspace, "lastfm_scrobble_source"), 1);
      assert.equal(count(workspace, "lastfm_scrobble_occurrence"), 1);
      assert.deepEqual(
        workspace.connection
          .prepare<ApiInterpretationRow>(
            `SELECT evidence.source_origin AS evidence_origin,
                    occurrence.source_origin AS occurrence_origin,
                    resolution.resolution_kind, event.event_status,
                    count(link.source_record_id) AS source_count
               FROM lastfm_scrobble_occurrence AS occurrence
               JOIN lastfm_scrobble_source AS evidence
                 ON evidence.source_record_id = occurrence.lastfm_scrobble_source_record_id
               JOIN source_identity_resolution AS resolution
                 ON resolution.source_record_id = occurrence.source_record_id
               JOIN listening_event_source AS link
                 ON link.source_record_id = occurrence.source_record_id
               JOIN listening_event AS event ON event.id = link.listening_event_id
              GROUP BY occurrence.source_record_id`,
          )
          .get(),
        {
          evidence_origin: "api",
          occurrence_origin: "api",
          resolution_kind: "new_unresolved",
          event_status: "unresolved",
          source_count: 1,
        },
      );
      assert.equal(
        validateEvidenceLayer(workspace.connection, workspace.configuration.paths.inputsDirectory)
          .ok,
        true,
      );
    });
  });

  it("links an API/export overlap, creates one canonical interpretation, and repeats as a no-op", () => {
    withTemporaryTestWorkspace((workspace) => {
      const exportRecord = buildLastfmScrobbleFixture({
        album_name: "Export Album",
        loved: null,
      });
      const exportPath = workspace.writeJsonFixture("lastfm/history.json", [exportRecord]);
      importLastfmExportFiles({
        candidatePaths: [exportPath],
        connection: workspace.connection,
        evidenceRoot: workspace.configuration.paths.inputsDirectory,
        now: () => 10_000,
        schemaVersion: "11",
      });

      const first = persist(workspace, [apiPage(apiTrack({ album_name: null, loved: true }))]);
      assert.deepEqual(first.records, {
        accepted: 1,
        discovered: 1,
        duplicated: 1,
        excluded: 0,
        rejected: 0,
      });
      assert.deepEqual(first.response, { completedTracks: 1, ignoredNowPlaying: 0, pages: 1 });
      assert.equal(count(workspace, "lastfm_scrobble_source"), 1);
      assert.equal(count(workspace, "source_record"), 2);
      assert.equal(
        workspace.connection
          .prepare<CountRow>(
            "SELECT count(*) AS count FROM listening_event WHERE event_status <> 'superseded'",
          )
          .get()?.count,
        1,
      );
      assert.deepEqual(
        workspace.connection
          .prepare<EventRow>(
            `SELECT event.event_status, count(link.source_record_id) AS source_count
               FROM listening_event AS event
               JOIN listening_event_source AS link ON link.listening_event_id = event.id
              WHERE event.event_status <> 'superseded'
              GROUP BY event.id`,
          )
          .get(),
        { event_status: "current", source_count: 2 },
      );
      assert.deepEqual(
        workspace.connection
          .prepare<OccurrenceRow>(
            `SELECT occurrence.source_origin,
                    occurrence.lastfm_scrobble_source_record_id AS evidence_source_record_id
               FROM lastfm_scrobble_occurrence AS occurrence
              ORDER BY occurrence.source_record_id`,
          )
          .all(),
        [
          { evidence_source_record_id: 1, source_origin: "export" },
          { evidence_source_record_id: 1, source_origin: "api" },
        ],
      );
      assert.deepEqual(
        workspace.connection
          .prepare(
            `SELECT page_count, completed_track_count, ignored_now_playing_count
               FROM lastfm_api_sync_metadata WHERE ingest_run_id = ?`,
          )
          .get([first.runId]),
        { completed_track_count: 1, ignored_now_playing_count: 0, page_count: 1 },
      );

      const repeated = persist(workspace, [apiPage(apiTrack({ album_name: null, loved: true }))]);
      assert.equal(repeated.noOp, true);
      assert.equal(count(workspace, "source_record"), 2);
      assert.equal(count(workspace, "lastfm_scrobble_source"), 1);
      assert.equal(
        workspace.connection
          .prepare<CountRow>(
            "SELECT count(*) AS count FROM listening_event WHERE event_status <> 'superseded'",
          )
          .get()?.count,
        1,
      );
      assert.equal(
        validateEvidenceLayer(workspace.connection, workspace.configuration.paths.inputsDirectory)
          .ok,
        true,
      );
    });
  });

  it("records only aggregate now-playing metadata and never persists an item without a completed timestamp", () => {
    withTemporaryTestWorkspace((workspace) => {
      const summary = persist(workspace, [apiPage(undefined, 1)]);
      assert.deepEqual(summary.records, {
        accepted: 0,
        discovered: 0,
        duplicated: 0,
        excluded: 0,
        rejected: 0,
      });
      assert.deepEqual(summary.response, { completedTracks: 0, ignoredNowPlaying: 1, pages: 1 });
      assert.equal(count(workspace, "source_record"), 0);
      assert.equal(count(workspace, "lastfm_scrobble_source"), 0);
      assert.equal(count(workspace, "lastfm_scrobble_occurrence"), 0);
      assert.equal(count(workspace, "listening_event"), 0);
      assert.equal(
        validateEvidenceLayer(workspace.connection, workspace.configuration.paths.inputsDirectory)
          .ok,
        true,
      );
    });
  });

  it("rolls back API evidence and metadata when canonicalization fails", () => {
    withTemporaryTestWorkspace((workspace) => {
      workspace.connection.execute(`
        CREATE TRIGGER fail_api_canonicalization
        BEFORE INSERT ON listening_event
        BEGIN
          SELECT RAISE(ABORT, 'synthetic canonicalization failure');
        END;
      `);

      assert.throws(
        () => persist(workspace, [apiPage(apiTrack())]),
        (error: unknown) =>
          error instanceof IngestLifecycleError && error.code === IngestIssueCode.IngestFailed,
      );
      for (const table of [
        "lastfm_api_sync_metadata",
        "lastfm_scrobble_occurrence",
        "lastfm_scrobble_source",
        "listening_event",
        "source_identity_resolution",
        "source_record",
      ]) {
        assert.equal(count(workspace, table), 0, `${table} should roll back`);
      }
      assert.deepEqual(
        workspace.connection
          .prepare<FailedRunRow>(
            `SELECT status, safe_error_summary
               FROM ingest_run
              WHERE command_type = 'lastfm_api_sync'`,
          )
          .get(),
        {
          status: "failed",
          safe_error_summary: "Import failed; no source evidence was committed",
        },
      );
      assert.equal(
        validateEvidenceLayer(workspace.connection, workspace.configuration.paths.inputsDirectory)
          .ok,
        true,
      );
    });
  });
});
