import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { generateVolumeAnalysis } from "../../../src/analytics/volume.ts";
import type { SqliteConnection } from "../../../src/db/connection.ts";
import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

function fingerprint(id: number): string {
  return id.toString(16).padStart(64, "0");
}

function insertEvent(
  connection: SqliteConnection,
  options: {
    readonly durationMs?: number;
    readonly eventId: number;
    readonly lastfm?: boolean;
    readonly spotify?: boolean;
    readonly startedAt: string;
  },
): void {
  const artistId = options.eventId * 10 + 1;
  const trackId = options.eventId * 10 + 2;
  const startedAtEpochMs = Date.parse(options.startedAt);
  const durationMs = options.durationMs ?? 30_000;
  connection
    .prepare(
      "INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '11')",
    )
    .run();
  connection
    .prepare(
      "INSERT INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (?, 'artist', 1), (?, 'track', 1)",
    )
    .run([artistId, trackId]);
  connection
    .prepare("INSERT INTO artist (id, preferred_name) VALUES (?, ?)")
    .run([artistId, `Artist ${options.eventId}`]);
  connection
    .prepare("INSERT INTO track (id, artist_id, preferred_title) VALUES (?, ?, ?)")
    .run([trackId, artistId, `Track ${options.eventId}`]);
  connection
    .prepare(
      "INSERT INTO listening_event (id, track_id, started_at_epoch_ms, ended_at_epoch_ms, listened_ms, time_basis, event_status, reconciliation_rule_version) VALUES (?, ?, ?, ?, ?, 'observed_start', 'current', 'canonical-event-v1')",
    )
    .run([
      options.eventId,
      trackId,
      startedAtEpochMs,
      startedAtEpochMs + durationMs,
      options.spotify ? durationMs : null,
    ]);
  if (options.spotify) {
    const sourceId = options.eventId * 100 + 1;
    connection
      .prepare(
        "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'spotify', 1, 1)",
      )
      .run([sourceId]);
    connection
      .prepare(
        "INSERT INTO spotify_play_source (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri, artist_name, track_name, shuffle, source_fingerprint_sha256) VALUES (?, 1, ?, ?, 'Synthetic Artist', 'Synthetic Track', 0, ?)",
      )
      .run([sourceId, durationMs, `spotify:track:${options.eventId}`, fingerprint(sourceId)]);
    connection
      .prepare(
        "INSERT INTO listening_event_source (listening_event_id, source_record_id, evidence_role) VALUES (?, ?, 'primary')",
      )
      .run([options.eventId, sourceId]);
  }
  if (options.lastfm) {
    const sourceId = options.eventId * 100 + 2;
    connection
      .prepare(
        "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'lastfm', 1, 1)",
      )
      .run([sourceId]);
    connection
      .prepare(
        "INSERT INTO lastfm_scrobble_source (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name, source_fingerprint_sha256) VALUES (?, 'export', 1, 'Synthetic Artist', 'Synthetic Track', ?)",
      )
      .run([sourceId, fingerprint(sourceId)]);
    connection
      .prepare(
        "INSERT INTO lastfm_scrobble_occurrence (source_record_id, lastfm_scrobble_source_record_id, source_origin) VALUES (?, ?, 'export')",
      )
      .run([sourceId, sourceId]);
    connection
      .prepare(
        "INSERT INTO listening_event_source (listening_event_id, source_record_id, evidence_role) VALUES (?, ?, 'primary')",
      )
      .run([options.eventId, sourceId]);
  }
}

describe("listening-volume analysis", () => {
  it("counts canonical events at every grain, including leap dates and empty requested periods", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertEvent(connection, { eventId: 1, lastfm: true, startedAt: "2024-02-28T18:00:00.000Z" });
      insertEvent(connection, { eventId: 2, spotify: true, startedAt: "2024-02-29T18:00:00.000Z" });
      insertEvent(connection, { eventId: 3, lastfm: true, startedAt: "2024-03-02T18:00:00.000Z" });
      const common = {
        endExclusive: "2024-03-03T00:00:00.000Z",
        startInclusive: "2024-02-28T00:00:00.000Z",
      };
      const daily = generateVolumeAnalysis({
        connection,
        parameters: { ...common, grain: "day" },
        presentationTimezone: "America/Chicago",
      });
      assert.deepEqual(
        daily.result.rows.map((row) => [row.period, row.value]),
        [
          ["2024-02-27", 0],
          ["2024-02-28", 1],
          ["2024-02-29", 1],
          ["2024-03-01", 0],
          ["2024-03-02", 1],
        ],
      );
      for (const [grain, expected] of [
        ["iso_week", ["2024-W09"]],
        ["month", ["2024-02", "2024-03"]],
        ["quarter", ["2024-Q1"]],
        ["year", ["2024"]],
      ] as const) {
        const result = generateVolumeAnalysis({
          connection,
          parameters: { ...common, grain },
          presentationTimezone: "America/Chicago",
        });
        assert.deepEqual(
          result.result.rows.map((row) => row.period),
          expected,
        );
        assert.equal(result.result.totalValue, 3);
      }
    });
  });

  it("crosses ISO week 53 into the next ISO year without dropping a period", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertEvent(connection, {
        eventId: 1,
        lastfm: true,
        startedAt: "2020-12-28T18:00:00.000Z",
      });
      insertEvent(connection, {
        eventId: 2,
        lastfm: true,
        startedAt: "2021-01-04T18:00:00.000Z",
      });

      const result = generateVolumeAnalysis({
        connection,
        parameters: { grain: "iso_week", rollingWindowPeriods: 2 },
        presentationTimezone: "America/Chicago",
      });

      assert.deepEqual(result.result.rows, [
        {
          period: "2020-W53",
          priorYearValue: null,
          rollingValue: 1,
          value: 1,
          yearOverYearAbsoluteChange: null,
          yearOverYearRate: null,
        },
        {
          period: "2021-W01",
          priorYearValue: null,
          rollingValue: 2,
          value: 1,
          yearOverYearAbsoluteChange: null,
          yearOverYearRate: null,
        },
      ]);
    });
  });

  it("crosses quarter and calendar-year boundaries with reconciled aggregate values", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertEvent(connection, {
        eventId: 1,
        lastfm: true,
        startedAt: "2024-12-31T18:00:00.000Z",
      });
      insertEvent(connection, {
        eventId: 2,
        lastfm: true,
        startedAt: "2025-01-01T18:00:00.000Z",
      });

      const quarter = generateVolumeAnalysis({
        connection,
        parameters: { grain: "quarter", rollingWindowPeriods: 2 },
        presentationTimezone: "America/Chicago",
      });
      assert.deepEqual(
        quarter.result.rows.map((row) => [row.period, row.value, row.rollingValue]),
        [
          ["2024-Q4", 1, 1],
          ["2025-Q1", 1, 2],
        ],
      );
      assert.equal(quarter.result.totalValue, 2);

      const year = generateVolumeAnalysis({
        connection,
        parameters: { grain: "year" },
        presentationTimezone: "America/Chicago",
      });
      assert.deepEqual(
        year.result.rows.map((row) => [row.period, row.value]),
        [
          ["2024", 1],
          ["2025", 1],
        ],
      );
      assert.equal(year.result.totalValue, year.eventCount);
    });
  });

  it("keeps full-history play count distinct from Spotify-backed duration metrics and counts a dual-source event once", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertEvent(connection, {
        durationMs: 10_000,
        eventId: 1,
        spotify: true,
        startedAt: "2025-01-01T18:00:00.000Z",
      });
      insertEvent(connection, {
        durationMs: 45_000,
        eventId: 2,
        lastfm: true,
        spotify: true,
        startedAt: "2025-01-01T19:00:00.000Z",
      });
      insertEvent(connection, { eventId: 3, lastfm: true, startedAt: "2025-01-01T20:00:00.000Z" });
      const base = {
        grain: "day",
        startInclusive: "2025-01-01T00:00:00.000Z",
        endExclusive: "2025-01-02T00:00:00.000Z",
      };
      const count = generateVolumeAnalysis({
        connection,
        parameters: base,
        presentationTimezone: "America/Chicago",
      });
      const thresholded = generateVolumeAnalysis({
        connection,
        parameters: { ...base, metric: "play_count_at_least_ms", minimumDurationMs: 30_000 },
        presentationTimezone: "America/Chicago",
      });
      const duration = generateVolumeAnalysis({
        connection,
        parameters: { ...base, metric: "listened_ms" },
        presentationTimezone: "America/Chicago",
      });
      assert.equal(count.result.totalValue, 3);
      assert.equal(thresholded.result.totalValue, 1);
      assert.equal(duration.result.totalValue, 55_000);
      assert.match(duration.result.metricLabel, /Spotify-backed only/u);
      assert.deepEqual(duration.metadataCoverage.spotifyDuration, {
        availableEventCount: 2,
        rate: 2 / 3,
        totalEventCount: 3,
      });
    });
  });

  it("derives rolling and year-over-year values from filled stable periods and reconciles aggregates", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertEvent(connection, { eventId: 1, lastfm: true, startedAt: "2023-01-15T18:00:00.000Z" });
      insertEvent(connection, { eventId: 2, lastfm: true, startedAt: "2024-01-15T18:00:00.000Z" });
      insertEvent(connection, { eventId: 3, lastfm: true, startedAt: "2024-01-16T18:00:00.000Z" });
      const result = generateVolumeAnalysis({
        connection,
        parameters: { grain: "year", rollingWindowPeriods: 2 },
        presentationTimezone: "America/Chicago",
      });
      assert.deepEqual(result.result.rows, [
        {
          period: "2023",
          priorYearValue: null,
          rollingValue: 1,
          value: 1,
          yearOverYearAbsoluteChange: null,
          yearOverYearRate: null,
        },
        {
          period: "2024",
          priorYearValue: 1,
          rollingValue: 3,
          value: 2,
          yearOverYearAbsoluteChange: 1,
          yearOverYearRate: 1,
        },
      ]);
      assert.equal(
        result.result.totalValue,
        result.result.rows.reduce((total, row) => total + row.value, 0),
      );
      assert.equal(result.eventCount, 3);
    });
  });

  it("rejects incomplete or invalid volume filters", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      assert.throws(
        () =>
          generateVolumeAnalysis({
            connection,
            parameters: { startInclusive: "2024-01-01T00:00:00.000Z" },
            presentationTimezone: "America/Chicago",
          }),
        /provided together/u,
      );
      assert.throws(
        () =>
          generateVolumeAnalysis({
            connection,
            parameters: { grain: "week" },
            presentationTimezone: "America/Chicago",
          }),
        /grain/u,
      );
    });
  });

  it("represents an unbounded empty selection without inventing a historical period", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const result = generateVolumeAnalysis({
        connection,
        presentationTimezone: "America/Chicago",
      });
      assert.equal(result.asOf, null);
      assert.equal(result.dateRange, null);
      assert.equal(result.eventCount, 0);
      assert.deepEqual(result.result.rows, []);
      assert.equal(result.result.totalValue, 0);
    });
  });
});
