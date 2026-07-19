import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { SqliteRow } from "../../../src/db/connection.ts";
import { IngestIssueCode, IngestIssueSummary } from "../../../src/importers/contracts.ts";
import {
  importLastfmExportFiles,
  LastfmRecordRejectionReason,
} from "../../../src/importers/lastfm-export/index.ts";
import { IngestLifecycleError } from "../../../src/importers/lifecycle.ts";
import { importSpotifyFiles } from "../../../src/importers/spotify/index.ts";
import { buildLastfmScrobbleFixture } from "../../fixtures/lastfm.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

interface CountRow extends SqliteRow {
  readonly count: number;
}

interface PersistedLastfmRow extends SqliteRow {
  readonly album_name: string | null;
  readonly artist_musicbrainz_id: string | null;
  readonly artist_name: string;
  readonly loved: number | null;
  readonly recording_musicbrainz_id: string | null;
  readonly release_musicbrainz_id: string | null;
  readonly scrobbled_at_epoch_ms: number;
  readonly source_fingerprint_sha256: string;
  readonly source_origin: string;
  readonly track_name: string;
}

interface OccurrenceRow extends SqliteRow {
  readonly evidence_source_record_id: number;
  readonly source_ordinal: number;
  readonly source_origin: string;
}

interface RejectionRow extends SqliteRow {
  readonly error_code: string;
  readonly safe_diagnostic_summary: string;
  readonly source_ordinal: number;
}

interface RunCountRow extends SqliteRow {
  readonly accepted_count: number;
  readonly discovered_count: number;
  readonly duplicated_count: number;
  readonly rejected_count: number;
}

interface SourceFileRangeRow extends SqliteRow {
  readonly observed_end_epoch_ms: number | null;
  readonly observed_start_epoch_ms: number | null;
}

function importFixture(
  workspace: TemporaryTestWorkspace,
  candidatePaths: readonly string[],
): ReturnType<typeof importLastfmExportFiles> {
  return importLastfmExportFiles({
    candidatePaths,
    connection: workspace.connection,
    evidenceRoot: workspace.configuration.paths.inputsDirectory,
    now: () => 20_000,
    schemaVersion: "4",
  });
}

function tableCount(workspace: TemporaryTestWorkspace, table: string): number {
  return (
    workspace.connection.prepare<CountRow>(`SELECT count(*) AS count FROM ${table}`).get()?.count ??
    -1
  );
}

describe("Last.fm export evidence persistence", () => {
  it("persists allowlisted evidence, ordinal provenance, safe rejections, and reconciled totals", () => {
    withTemporaryTestWorkspace((workspace) => {
      const privateMarker = "synthetic-lastfm-sensitive-marker";
      const first = buildLastfmScrobbleFixture({
        artist_name: "Beyoncé de Prueba",
        album_name: "Señales синтетические",
        track_name: "雪のテスト — Café 🎧",
        loved: true,
      });
      const second = buildLastfmScrobbleFixture({
        timestamp: first.timestamp + 1,
        album_name: null,
        artist_musicbrainz_id: null,
        release_musicbrainz_id: null,
        recording_musicbrainz_id: null,
        loved: null,
      });
      const fixturePath = workspace.writeJsonFixture("lastfm/history.json", [
        { ...first, unknown_private_field: privateMarker },
        { ...first },
        buildLastfmScrobbleFixture({ timestamp: privateMarker }),
        second,
      ]);
      const originalContents = readFileSync(fixturePath);

      const summary = importFixture(workspace, [fixturePath]);

      assert.deepEqual(summary.files, {
        discovered: 1,
        registered: 1,
        noOp: 0,
        unsupported: 0,
      });
      assert.deepEqual(summary.records, {
        discovered: 4,
        accepted: 3,
        duplicated: 1,
        excluded: 0,
        rejected: 1,
      });
      assert.deepEqual(summary.fingerprintVersions, {
        source: "lastfm-source-v1",
        overlap: "lastfm-overlap-v1",
      });

      const evidence = workspace.connection
        .prepare<PersistedLastfmRow>(
          `SELECT source_origin, scrobbled_at_epoch_ms, artist_name, album_name, track_name,
                  artist_musicbrainz_id, release_musicbrainz_id, recording_musicbrainz_id,
                  loved, source_fingerprint_sha256
           FROM lastfm_scrobble_source
           ORDER BY scrobbled_at_epoch_ms`,
        )
        .all();
      assert.equal(evidence.length, 2);
      assert.deepEqual(evidence[0], {
        source_origin: "export",
        scrobbled_at_epoch_ms: first.timestamp,
        artist_name: first.artist_name,
        album_name: first.album_name,
        track_name: first.track_name,
        artist_musicbrainz_id: first.artist_musicbrainz_id,
        release_musicbrainz_id: first.release_musicbrainz_id,
        recording_musicbrainz_id: first.recording_musicbrainz_id,
        loved: 1,
        source_fingerprint_sha256: evidence[0]?.source_fingerprint_sha256,
      });
      assert.match(evidence[0]?.source_fingerprint_sha256 ?? "", /^[0-9a-f]{64}$/);
      assert.equal(evidence[1]?.album_name, null);
      assert.equal(evidence[1]?.loved, null);

      const occurrences = workspace.connection
        .prepare<OccurrenceRow>(
          `SELECT source.source_ordinal,
                  occurrence.lastfm_scrobble_source_record_id AS evidence_source_record_id,
                  occurrence.source_origin
           FROM lastfm_scrobble_occurrence AS occurrence
           JOIN source_record AS source ON source.id = occurrence.source_record_id
           ORDER BY source.source_ordinal`,
        )
        .all();
      assert.equal(occurrences.length, 3);
      assert.deepEqual(
        occurrences.map((row) => row.source_ordinal),
        [0, 1, 3],
      );
      assert.equal(
        occurrences[0]?.evidence_source_record_id,
        occurrences[1]?.evidence_source_record_id,
      );
      assert.deepEqual(
        occurrences.map((row) => row.source_origin),
        ["export", "export", "export"],
      );

      assert.deepEqual(
        workspace.connection
          .prepare<RejectionRow>(
            `SELECT source_ordinal, error_code, safe_diagnostic_summary
             FROM rejected_source_record`,
          )
          .get(),
        {
          source_ordinal: 2,
          error_code: LastfmRecordRejectionReason.InvalidTimestamp,
          safe_diagnostic_summary: IngestIssueSummary[IngestIssueCode.RejectedRecord],
        },
      );
      assert.deepEqual(
        workspace.connection
          .prepare<RunCountRow>(
            `SELECT discovered_count, accepted_count, duplicated_count, rejected_count
             FROM ingest_run WHERE id = ?`,
          )
          .get([summary.runId]),
        { discovered_count: 4, accepted_count: 3, duplicated_count: 1, rejected_count: 1 },
      );
      assert.deepEqual(
        workspace.connection
          .prepare<SourceFileRangeRow>(
            `SELECT observed_start_epoch_ms, observed_end_epoch_ms
             FROM source_file`,
          )
          .get(),
        {
          observed_start_epoch_ms: first.timestamp,
          observed_end_epoch_ms: second.timestamp,
        },
      );
      assert.equal(tableCount(workspace, "source_record"), summary.records.accepted);
      assert.equal(tableCount(workspace, "lastfm_scrobble_occurrence"), summary.records.accepted);
      assert.equal(tableCount(workspace, "rejected_source_record"), summary.records.rejected);

      const persistedText = JSON.stringify([...evidence, ...occurrences]);
      assert.equal(persistedText.includes(privateMarker), false);
      assert.deepEqual(readFileSync(fixturePath), originalContents);
      assert.equal(originalContents.toString("utf8").includes(privateMarker), true);
      assert.equal(workspace.connection.checkIntegrity().ok, true);
    });
  });

  it("makes unchanged and byte-identical renamed exports no-ops", () => {
    withTemporaryTestWorkspace((workspace) => {
      const records = [buildLastfmScrobbleFixture()];
      const original = workspace.writeJsonFixture("lastfm/history-original.json", records);
      const renamed = workspace.writeJsonFixture("lastfm/history-renamed.json", records);

      const first = importFixture(workspace, [original]);
      const unchanged = importFixture(workspace, [original]);
      const byteIdenticalRename = importFixture(workspace, [renamed]);

      assert.equal(first.records.accepted, 1);
      assert.equal(unchanged.noOp, true);
      assert.equal(byteIdenticalRename.noOp, true);
      assert.equal(byteIdenticalRename.files.noOp, 1);
      assert.equal(tableCount(workspace, "source_file"), 1);
      assert.equal(tableCount(workspace, "lastfm_scrobble_source"), 1);
      assert.equal(tableCount(workspace, "lastfm_scrobble_occurrence"), 1);
    });
  });

  it("registers byte-identical files independently when their source types differ", () => {
    for (const firstSource of ["spotify", "lastfm"] as const) {
      withTemporaryTestWorkspace((workspace) => {
        const spotify = workspace.writeJsonFixture(
          "spotify/Streaming_History_Audio_2026_0.json",
          [],
        );
        const lastfm = workspace.writeJsonFixture("lastfm/history-empty.json", []);
        assert.deepEqual(readFileSync(spotify), readFileSync(lastfm));

        const importSpotify = () =>
          importSpotifyFiles({
            candidatePaths: [spotify],
            connection: workspace.connection,
            evidenceRoot: workspace.configuration.paths.inputsDirectory,
            now: () => 20_000,
            schemaVersion: "4",
          });
        const importLastfm = () => importFixture(workspace, [lastfm]);

        const first = firstSource === "spotify" ? importSpotify() : importLastfm();
        const second = firstSource === "spotify" ? importLastfm() : importSpotify();

        assert.equal(first.files.registered, 1);
        assert.equal(second.files.registered, 1);
        assert.equal(tableCount(workspace, "source_file"), 2);
        assert.deepEqual(
          workspace.connection
            .prepare<{ readonly source_type: string }>(
              "SELECT source_type FROM source_file ORDER BY source_type",
            )
            .all()
            .map((row) => row.source_type),
          ["lastfm_export", "spotify_export"],
        );
      });
    }
  });

  it("rolls back all source writes when any supported export fails", () => {
    withTemporaryTestWorkspace((workspace) => {
      const valid = workspace.writeJsonFixture("lastfm/history-valid.json", [
        buildLastfmScrobbleFixture(),
      ]);
      const malformed = workspace.writeJsonFixture("lastfm/history-malformed.json", {
        not: "an array",
      });

      assert.throws(
        () => importFixture(workspace, [valid, malformed]),
        (error: unknown) =>
          error instanceof IngestLifecycleError &&
          error.code === IngestIssueCode.MalformedFile &&
          error.safeSummary === IngestIssueSummary[IngestIssueCode.MalformedFile],
      );

      for (const table of [
        "source_file",
        "source_record",
        "lastfm_scrobble_source",
        "lastfm_scrobble_occurrence",
        "rejected_source_record",
      ]) {
        assert.equal(tableCount(workspace, table), 0);
      }
      assert.equal(
        workspace.connection
          .prepare<CountRow>("SELECT count(*) AS count FROM ingest_run WHERE status = 'failed'")
          .get()?.count,
        1,
      );
    });
  });

  it("counts unsupported explicit paths without reading or registering them", () => {
    withTemporaryTestWorkspace((workspace) => {
      const unsupported = workspace.writeJsonFixture("lastfm/history.csv", [
        buildLastfmScrobbleFixture(),
      ]);
      const summary = importFixture(workspace, [
        unsupported,
        path.join(workspace.rootPath, "gone.json"),
      ]);

      assert.deepEqual(summary.files, {
        discovered: 2,
        registered: 0,
        noOp: 0,
        unsupported: 2,
      });
      assert.equal(summary.records.discovered, 0);
      assert.equal(tableCount(workspace, "source_file"), 0);
    });
  });
});
