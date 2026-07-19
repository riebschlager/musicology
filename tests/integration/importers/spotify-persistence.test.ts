import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { SqliteRow } from "../../../src/db/connection.ts";
import { IngestIssueSummary, IngestIssueCode } from "../../../src/importers/contracts.ts";
import { IngestLifecycleError } from "../../../src/importers/lifecycle.ts";
import {
  importSpotifyFiles,
  SpotifyRecordRejectionReason,
} from "../../../src/importers/spotify/index.ts";
import { buildSpotifyEpisodeFixture, buildSpotifyTrackFixture } from "../../fixtures/spotify.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

interface CountRow extends SqliteRow {
  readonly count: number;
}

interface FingerprintGroupRow extends SqliteRow {
  readonly evidence_count: number;
  readonly source_fingerprint_sha256: string;
}

interface PersistedSpotifyRow extends SqliteRow {
  readonly album_name: string | null;
  readonly artist_name: string;
  readonly ms_played: number;
  readonly offline: number | null;
  readonly offline_at_epoch_ms: number | null;
  readonly reason_end: string | null;
  readonly reason_start: string | null;
  readonly shuffle: number;
  readonly skipped: number | null;
  readonly source_ordinal: number;
  readonly spotify_track_uri: string;
  readonly stopped_at_epoch_ms: number;
  readonly track_name: string;
}

interface RejectionRow extends SqliteRow {
  readonly error_code: string;
  readonly safe_diagnostic_summary: string;
  readonly source_ordinal: number;
}

interface SourceFileRow extends SqliteRow {
  readonly content_sha256: string;
  readonly observed_end_epoch_ms: number | null;
  readonly observed_start_epoch_ms: number | null;
  readonly relative_path: string;
}

function importFixture(
  workspace: TemporaryTestWorkspace,
  candidatePaths: readonly string[],
): ReturnType<typeof importSpotifyFiles> {
  return importSpotifyFiles({
    candidatePaths,
    connection: workspace.connection,
    evidenceRoot: workspace.configuration.paths.inputsDirectory,
    now: () => 10_000,
    schemaVersion: "2",
  });
}

describe("Spotify evidence persistence", () => {
  it("persists only allowlisted track evidence, safe rejections, and non-music counts", () => {
    withTemporaryTestWorkspace((workspace) => {
      const privateMarker = "synthetic-sensitive-import-marker";
      const first = buildSpotifyTrackFixture({
        master_metadata_album_album_name: "Álbum de Prueba",
        master_metadata_album_artist_name: "Beyoncé de Prueba",
        master_metadata_track_name: "雪のテスト — Café 🎧",
        offline: true,
        offline_timestamp: 1_767_322_800_000,
        skipped: null,
      });
      const fixturePath = workspace.writeJsonFixture(
        "spotify/Streaming_History_Audio_2026_0.json",
        [
          {
            ...first,
            ["ip_" + "addr"]: privateMarker,
            ["plat" + "form"]: privateMarker,
            ["user" + "name"]: privateMarker,
          },
          buildSpotifyEpisodeFixture(),
          buildSpotifyTrackFixture({ spotify_track_uri: null }),
          buildSpotifyTrackFixture({ ms_played: privateMarker }),
        ],
      );
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
        accepted: 1,
        duplicated: 0,
        excluded: 2,
        rejected: 1,
      });
      assert.deepEqual(summary.nonMusic, {
        episodeOrAudiobook: 1,
        videoOrUnsupported: 1,
      });

      const persisted = workspace.connection
        .prepare<PersistedSpotifyRow>(
          `SELECT source.source_ordinal, spotify.stopped_at_epoch_ms, spotify.ms_played,
                  spotify.spotify_track_uri, spotify.artist_name, spotify.album_name,
                  spotify.track_name, spotify.reason_start, spotify.reason_end,
                  spotify.shuffle, spotify.skipped, spotify.offline,
                  spotify.offline_at_epoch_ms
           FROM spotify_play_source AS spotify
           JOIN source_record AS source ON source.id = spotify.source_record_id`,
        )
        .get();
      assert.deepEqual(persisted, {
        source_ordinal: 0,
        stopped_at_epoch_ms: Date.parse(first.ts),
        ms_played: first.ms_played,
        spotify_track_uri: first.spotify_track_uri,
        artist_name: first.master_metadata_album_artist_name,
        album_name: first.master_metadata_album_album_name,
        track_name: first.master_metadata_track_name,
        reason_start: first.reason_start,
        reason_end: first.reason_end,
        shuffle: 0,
        skipped: null,
        offline: 1,
        offline_at_epoch_ms: first.offline_timestamp,
      });

      assert.deepEqual(
        workspace.connection
          .prepare<RejectionRow>(
            `SELECT source_ordinal, error_code, safe_diagnostic_summary
             FROM rejected_source_record`,
          )
          .get(),
        {
          source_ordinal: 3,
          error_code: SpotifyRecordRejectionReason.InvalidDuration,
          safe_diagnostic_summary: IngestIssueSummary[IngestIssueCode.RejectedRecord],
        },
      );
      const databaseText = workspace.connection
        .prepare<SqliteRow>(
          `SELECT group_concat(value, '') AS text
           FROM (
             SELECT artist_name AS value FROM spotify_play_source
             UNION ALL SELECT album_name FROM spotify_play_source
             UNION ALL SELECT track_name FROM spotify_play_source
             UNION ALL SELECT safe_diagnostic_summary FROM rejected_source_record
             UNION ALL SELECT error_code FROM rejected_source_record
           )`,
        )
        .get()?.text;
      assert.equal(String(databaseText).includes(privateMarker), false);

      const sourceFile = workspace.connection
        .prepare<SourceFileRow>(
          `SELECT relative_path, content_sha256, observed_start_epoch_ms, observed_end_epoch_ms
           FROM source_file`,
        )
        .get();
      assert.equal(sourceFile?.relative_path, "spotify/Streaming_History_Audio_2026_0.json");
      assert.equal(sourceFile?.content_sha256.length, 64);
      assert.equal(sourceFile?.observed_start_epoch_ms, Date.parse(first.ts));
      assert.equal(sourceFile?.observed_end_epoch_ms, Date.parse(first.ts));
      assert.deepEqual(readFileSync(fixturePath), originalContents);
      assert.equal(originalContents.toString("utf8").includes(privateMarker), true);
      assert.equal(workspace.connection.checkIntegrity().ok, true);
    });
  });

  it("keeps 401-style exact duplicates as separate evidence rows in one fingerprint group", () => {
    withTemporaryTestWorkspace((workspace) => {
      const exactRecord = buildSpotifyTrackFixture();
      const fixturePath = workspace.writeJsonFixture(
        "spotify/Streaming_History_Audio_2026_1.json",
        Array.from({ length: 402 }, () => ({ ...exactRecord })),
      );

      const summary = importFixture(workspace, [fixturePath]);
      const groups = workspace.connection
        .prepare<FingerprintGroupRow>(
          `SELECT source_fingerprint_sha256, count(*) AS evidence_count
           FROM spotify_play_source
           GROUP BY source_fingerprint_sha256`,
        )
        .all();

      assert.equal(summary.records.accepted, 402);
      assert.equal(summary.records.duplicated, 401);
      assert.equal(groups.length, 1);
      assert.equal(groups[0]?.evidence_count, 402);
      assert.match(groups[0]?.source_fingerprint_sha256 ?? "", /^[0-9a-f]{64}$/);
      assert.equal(
        workspace.connection.prepare<CountRow>("SELECT count(*) AS count FROM source_record").get()
          ?.count,
        402,
      );
    });
  });

  it("makes unchanged and byte-identical renamed files no-ops", () => {
    withTemporaryTestWorkspace((workspace) => {
      const records = [buildSpotifyTrackFixture()];
      const original = workspace.writeJsonFixture(
        "spotify/Streaming_History_Audio_2026_2.json",
        records,
      );
      const renamed = workspace.writeJsonFixture(
        "renamed/Streaming_History_Audio_2026_3.json",
        records,
      );

      const first = importFixture(workspace, [original]);
      const unchanged = importFixture(workspace, [original]);
      const byteIdenticalRename = importFixture(workspace, [renamed]);

      assert.equal(first.records.accepted, 1);
      assert.equal(unchanged.noOp, true);
      assert.equal(byteIdenticalRename.noOp, true);
      assert.equal(byteIdenticalRename.files.noOp, 1);
      assert.equal(
        workspace.connection.prepare<CountRow>("SELECT count(*) AS count FROM source_file").get()
          ?.count,
        1,
      );
      assert.equal(
        workspace.connection
          .prepare<CountRow>("SELECT count(*) AS count FROM spotify_play_source")
          .get()?.count,
        1,
      );
    });
  });

  it("rolls back every file write when a supported file fails", () => {
    withTemporaryTestWorkspace((workspace) => {
      const valid = workspace.writeJsonFixture("spotify/Streaming_History_Audio_2026_4.json", [
        buildSpotifyTrackFixture(),
      ]);
      const malformed = workspace.writeJsonFixture("spotify/Streaming_History_Audio_2026_5.json", {
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
        "spotify_play_source",
        "rejected_source_record",
      ]) {
        assert.equal(
          workspace.connection.prepare<CountRow>(`SELECT count(*) AS count FROM ${table}`).get()
            ?.count,
          0,
        );
      }
      assert.equal(
        workspace.connection
          .prepare<CountRow>("SELECT count(*) AS count FROM ingest_run WHERE status = 'failed'")
          .get()?.count,
        1,
      );
    });
  });

  it("counts explicit unsupported paths without reading or registering them", () => {
    withTemporaryTestWorkspace((workspace) => {
      const unsupported = workspace.writeJsonFixture("spotify/arbitrary.json", [
        buildSpotifyTrackFixture(),
      ]);
      const summary = importFixture(workspace, [
        unsupported,
        path.join(workspace.rootPath, "gone"),
      ]);

      assert.deepEqual(summary.files, {
        discovered: 2,
        registered: 0,
        noOp: 0,
        unsupported: 2,
      });
      assert.equal(summary.records.discovered, 0);
      assert.equal(
        workspace.connection.prepare<CountRow>("SELECT count(*) AS count FROM source_file").get()
          ?.count,
        0,
      );
    });
  });
});
