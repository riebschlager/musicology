import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { importLastfmExportFiles } from "../../../src/importers/lastfm-export/persistence.ts";
import { importSpotifyFiles } from "../../../src/importers/spotify/persistence.ts";
import {
  collapseExactDuplicateEvents,
  createCanonicalEvents,
} from "../../../src/identity/events.ts";
import { resolveSourceIdentities } from "../../../src/identity/resolution.ts";
import {
  COVERAGE_REPORT_VERSION,
  generateCoverageReport,
  LONG_GAP_THRESHOLD_DAYS,
} from "../../../src/reporting/coverage.ts";
import {
  buildLastfmScrobbleFixture,
  buildSpotifyEpisodeFixture,
  buildSpotifyTrackFixture,
  epochMilliseconds,
} from "../../fixtures/index.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

const PRIVATE_SENTINEL = "synthetic-private-source-value-must-not-escape";

function importCoverageFixtures(workspace: TemporaryTestWorkspace): void {
  const spotifyDuplicate = buildSpotifyTrackFixture({
    ts: "2020-01-01T02:00:00.000Z",
    master_metadata_album_album_name: null,
    spotify_track_uri: "spotify:track:0000000000000000000011",
  });
  const spotifyPath = workspace.writeJsonFixture(
    "spotify/Streaming_History_Audio_2019-2022_0.json",
    [
      spotifyDuplicate,
      { ...spotifyDuplicate },
      buildSpotifyTrackFixture({
        ts: "2022-01-02T02:00:00.000Z",
        master_metadata_track_name: PRIVATE_SENTINEL,
        spotify_track_uri: "spotify:track:0000000000000000000012",
      }),
      buildSpotifyEpisodeFixture(),
      buildSpotifyTrackFixture({ ms_played: "malformed" }),
    ],
  );
  const lastfmDuplicate = buildLastfmScrobbleFixture({
    timestamp: epochMilliseconds("2020-01-02T00:00:00.000Z"),
    recording_musicbrainz_id: "00000000-0000-4000-8000-000000000011",
  });
  const lastfmPath = workspace.writeJsonFixture("lastfm/coverage.json", [
    buildLastfmScrobbleFixture({
      timestamp: epochMilliseconds("2018-01-01T00:00:00.000Z"),
      album_name: null,
      artist_musicbrainz_id: null,
      release_musicbrainz_id: null,
      recording_musicbrainz_id: null,
      loved: null,
    }),
    lastfmDuplicate,
    { ...lastfmDuplicate },
    buildLastfmScrobbleFixture({ timestamp: "malformed" }),
  ]);

  importSpotifyFiles({
    candidatePaths: [spotifyPath],
    connection: workspace.connection,
    evidenceRoot: workspace.configuration.paths.inputsDirectory,
    now: () => 1_800_000_000_000,
    schemaVersion: "4",
  });
  importLastfmExportFiles({
    candidatePaths: [lastfmPath],
    connection: workspace.connection,
    evidenceRoot: workspace.configuration.paths.inputsDirectory,
    now: () => 1_800_000_001_000,
    schemaVersion: "4",
  });
  resolveSourceIdentities(workspace.connection, { now: () => 1_800_000_001_500 });
  createCanonicalEvents(workspace.connection);
  collapseExactDuplicateEvents(workspace.connection);
}

describe("coverage reporting", () => {
  it("reconciles evidence totals and reports timezone years, missing data, duplicates, and gaps", () => {
    withTemporaryTestWorkspace((workspace) => {
      importCoverageFixtures(workspace);

      const report = generateCoverageReport({
        connection: workspace.connection,
        timezone: "America/Chicago",
        now: () => epochMilliseconds("2026-07-19T12:00:00.000Z"),
        compareArchiveBaseline: true,
      });

      assert.equal(report.reportVersion, COVERAGE_REPORT_VERSION);
      assert.equal(report.generatedAt, "2026-07-19T12:00:00.000Z");
      assert.equal(report.semantics.canonicalEventCountsIncluded, true);
      assert.equal(report.totals.evidenceOccurrences, 6);
      assert.equal(report.totals.accepted, 6);
      assert.equal(report.totals.rejected, 2);
      assert.equal(report.totals.nonMusic, 1);
      assert.equal(report.totals.canonicalEvents, 4);
      assert.deepEqual(report.canonical.bySourceBacking, { spotify: 2, lastfm: 2, both: 0 });
      assert.deepEqual(report.canonical.merges, {
        exactDuplicateEvents: 2,
        exactDuplicateSourceLinks: 2,
        inferredCrossSourceEvents: 0,
        inferredCrossSourceSourceLinks: 0,
      });
      assert.equal(report.canonical.unresolved.eventCount, 0);
      assert.equal(report.canonical.unresolved.rate, 0);
      assert.deepEqual(report.canonical.overlapByYear, []);
      assert.equal(JSON.stringify(report).includes(PRIVATE_SENTINEL), false);
      assert.equal(report.inputFiles.length, 2);
      assert.ok(report.inputFiles.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256)));

      const spotify = report.sources.find((source) => source.source === "spotify");
      const lastfm = report.sources.find((source) => source.source === "lastfm");
      assert.notEqual(spotify, undefined);
      assert.notEqual(lastfm, undefined);
      assert.deepEqual(spotify?.totals, { accepted: 3, rejected: 1, nonMusic: 1 });
      assert.deepEqual(spotify?.byYear, [
        { year: 2019, evidenceCount: 2 },
        { year: 2022, evidenceCount: 1 },
      ]);
      assert.deepEqual(spotify?.observedRange, {
        firstObservedAt: "2020-01-01T02:00:00.000Z",
        lastObservedAt: "2022-01-02T02:00:00.000Z",
      });
      assert.deepEqual(spotify?.duplicates, { groupCount: 1, extraEvidenceCount: 1 });
      assert.equal(
        spotify?.missingFields.find((field) => field.field === "albumName")?.missingCount,
        2,
      );
      assert.deepEqual(spotify?.longGaps, [
        {
          after: "2020-01-01T02:00:00.000Z",
          before: "2022-01-02T02:00:00.000Z",
          durationDays: 732,
        },
      ]);

      assert.deepEqual(lastfm?.totals, { accepted: 3, rejected: 1, nonMusic: 0 });
      assert.deepEqual(lastfm?.duplicates, { groupCount: 1, extraEvidenceCount: 1 });
      assert.equal(
        lastfm?.missingFields.find((field) => field.field === "recordingMusicBrainzId")
          ?.missingRate,
        1 / 3,
      );
      assert.equal(lastfm?.longGaps.length, 1);
      assert.equal(report.archiveBaselineComparison?.matches, false);
      assert.equal(report.archiveBaselineComparison?.deviations.length, 7);

      const spotifyTableCount = workspace.connection
        .prepare<{ readonly count: number }>("SELECT count(*) AS count FROM spotify_play_source")
        .get()?.count;
      const lastfmTableCount = workspace.connection
        .prepare<{ readonly count: number }>(
          "SELECT count(*) AS count FROM lastfm_scrobble_occurrence",
        )
        .get()?.count;
      const rejectedTableCount = workspace.connection
        .prepare<{ readonly count: number }>("SELECT count(*) AS count FROM rejected_source_record")
        .get()?.count;
      const nonMusicTableTotal = workspace.connection
        .prepare<{ readonly count: number }>(
          "SELECT coalesce(sum(excluded_count), 0) AS count FROM ingest_run WHERE status = 'succeeded'",
        )
        .get()?.count;
      assert.equal(spotify?.totals.accepted, spotifyTableCount);
      assert.equal(lastfm?.totals.accepted, lastfmTableCount);
      assert.equal(report.totals.rejected, rejectedTableCount);
      assert.equal(report.totals.nonMusic, nonMusicTableTotal);
      assert.equal(
        report.sources
          .flatMap((source) => source.byYear)
          .reduce((sum, year) => sum + year.evidenceCount, 0),
        report.totals.evidenceOccurrences,
      );
    });
  });

  it("includes gaps exactly at 365 days and excludes gaps immediately below the threshold", () => {
    withTemporaryTestWorkspace((workspace) => {
      const dayMilliseconds = 86_400_000;
      const firstTimestamp = epochMilliseconds("2020-01-01T00:00:00.000Z");
      const belowThresholdTimestamp =
        firstTimestamp + LONG_GAP_THRESHOLD_DAYS * dayMilliseconds - 1;
      const atThresholdTimestamp =
        belowThresholdTimestamp + LONG_GAP_THRESHOLD_DAYS * dayMilliseconds;
      const spotifyPath = workspace.writeJsonFixture(
        "spotify/Streaming_History_Audio_2020-2021_0.json",
        [firstTimestamp, belowThresholdTimestamp, atThresholdTimestamp].map((timestamp, index) =>
          buildSpotifyTrackFixture({
            ts: new Date(timestamp).toISOString(),
            spotify_track_uri: `spotify:track:${String(index + 20).padStart(22, "0")}`,
          }),
        ),
      );
      importSpotifyFiles({
        candidatePaths: [spotifyPath],
        connection: workspace.connection,
        evidenceRoot: workspace.configuration.paths.inputsDirectory,
        now: () => 1_800_000_000_000,
        schemaVersion: "4",
      });

      const report = generateCoverageReport({
        connection: workspace.connection,
        timezone: "UTC",
        now: () => 1_800_000_001_000,
      });
      const spotify = report.sources.find((source) => source.source === "spotify");

      assert.equal(report.semantics.longGapThresholdDays, 365);
      assert.deepEqual(spotify?.longGaps, [
        {
          after: new Date(belowThresholdTimestamp).toISOString(),
          before: new Date(atThresholdTimestamp).toISOString(),
          durationDays: 365,
        },
      ]);
    });
  });

  it("is stable over unchanged evidence except for declared generation metadata", () => {
    withTemporaryTestWorkspace((workspace) => {
      importCoverageFixtures(workspace);
      const first = generateCoverageReport({
        connection: workspace.connection,
        timezone: "UTC",
        now: () => 1_800_000_000_000,
      });
      const second = generateCoverageReport({
        connection: workspace.connection,
        timezone: "UTC",
        now: () => 1_800_000_001_000,
      });

      assert.notEqual(first.generatedAt, second.generatedAt);
      const { generatedAt: firstGeneratedAt, ...firstStable } = first;
      const { generatedAt: secondGeneratedAt, ...secondStable } = second;
      assert.notEqual(firstGeneratedAt, secondGeneratedAt);
      assert.deepEqual(firstStable, secondStable);
    });
  });
});
