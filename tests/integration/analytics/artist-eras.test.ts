import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { generateArtistEraAnalysis } from "../../../src/analytics/artist-eras.ts";
import { serializeAnalyticalResult } from "../../../src/analytics/result.ts";
import type { SqliteConnection } from "../../../src/db/connection.ts";
import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

interface SyntheticPlay {
  readonly artist: string;
  readonly at: string;
  readonly id: number;
}

function fingerprint(id: number): string {
  return id.toString(16).padStart(64, "0");
}

function insertPlay(connection: SqliteConnection, play: SyntheticPlay): void {
  const artistId = artistIdFor(play.artist);
  const trackId = play.id * 10 + 2;
  const sourceId = play.id * 100 + 1;
  const startedAt = Date.parse(play.at);
  connection
    .prepare(
      "INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '11')",
    )
    .run();
  connection
    .prepare(
      "INSERT OR IGNORE INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (?, 'artist', 1)",
    )
    .run([artistId]);
  connection
    .prepare(
      "INSERT INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (?, 'track', 1)",
    )
    .run([trackId]);
  connection
    .prepare("INSERT OR IGNORE INTO artist (id, preferred_name) VALUES (?, ?)")
    .run([artistId, play.artist]);
  connection
    .prepare("INSERT INTO track (id, artist_id, preferred_title) VALUES (?, ?, 'Synthetic Track')")
    .run([trackId, artistId]);
  connection
    .prepare(
      "INSERT INTO listening_event (id, track_id, started_at_epoch_ms, ended_at_epoch_ms, time_basis, event_status, reconciliation_rule_version) VALUES (?, ?, ?, ?, 'observed_start', 'current', 'canonical-event-v1')",
    )
    .run([play.id, trackId, startedAt, startedAt + 30_000]);
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
    .run([play.id, sourceId]);
}

function artistIdFor(artist: string): number {
  return [...artist].reduce((sum, character) => sum * 31 + (character.codePointAt(0) ?? 0), 0) + 1;
}

function plays(
  artist: string,
  month: number,
  startId: number,
  count: number,
): readonly SyntheticPlay[] {
  return Array.from({ length: count }, (_, index) => ({
    artist,
    at: `2024-${String(month).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}T18:00:00.000Z`,
    id: startId + index,
  }));
}

const parameters = {
  maximumRank: 10,
  minimumConsecutiveActiveWindows: 2,
  minimumEarlierBaselineChange: -100,
  minimumListeningShare: 0.05,
  minimumRollingPlayCount: 2,
  minimumWindowPlayCount: 2,
  rollingWindowCount: 2,
  windowSizeMonths: 1,
};

describe("artist-era analysis", () => {
  it("assembles rising, sustained, fading, and overlapping qualifying windows while excluding insufficient activity", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const history = [
        ...plays("Rising", 1, 1, 1),
        ...plays("Rising", 2, 10, 2),
        ...plays("Rising", 3, 20, 3),
        ...plays("Rising", 4, 30, 3),
        ...plays("Sustained", 1, 40, 2),
        ...plays("Sustained", 2, 50, 2),
        ...plays("Sustained", 3, 60, 2),
        ...plays("Sustained", 4, 70, 2),
        ...plays("Fading", 1, 80, 3),
        ...plays("Fading", 2, 90, 3),
        ...plays("Fading", 3, 100, 2),
        ...plays("Fading", 4, 110, 2),
        ...plays("Insufficient", 4, 120, 1),
        ...plays("Anchor", 5, 130, 1),
      ];
      for (const play of history) insertPlay(connection, play);

      const analysis = generateArtistEraAnalysis({
        connection,
        parameters,
        presentationTimezone: "America/Chicago",
      });
      const intervals = analysis.result.intervals;
      assert.deepEqual(
        intervals.map((interval) => [
          interval.artistDisplayName,
          interval.windowStart,
          interval.windowEndExclusive,
        ]),
        [
          ["Fading", "2024-02", "2024-05"],
          ["Sustained", "2024-02", "2024-05"],
          ["Rising", "2024-03", "2024-05"],
        ],
      );
      assert.equal(
        intervals.some((interval) => interval.artistDisplayName === "Insufficient"),
        false,
      );
      const rising = intervals.find((interval) => interval.artistDisplayName === "Rising");
      assert.ok(rising);
      assert.equal(rising.playCount, 6);
      assert.deepEqual(
        rising.evidence.map((window) => window.components.windowPlayCount),
        [3, 3],
      );
      assert.deepEqual(
        rising.evidence.map((window) => window.components.rollingPlayCount),
        [5, 6],
      );
      assert.equal(rising.peak.windowStart, "2024-04");
      assert.equal(analysis.metadataCoverage.lastfmSource?.rate, 1);
      assert.equal(analysis.metadataCoverage.spotifySource?.rate, 0);
    });
  });

  it("is deterministic when equivalent canonical evidence is inserted in a different order", () => {
    const history = [
      ...plays("One", 1, 1, 2),
      ...plays("One", 2, 10, 2),
      ...plays("One", 3, 20, 2),
      ...plays("Two", 2, 30, 2),
      ...plays("Two", 3, 40, 2),
    ];
    const render = (input: readonly SyntheticPlay[]): string => {
      let output = "";
      withTemporarySqliteDatabase(({ connection }) => {
        applyMigrations(connection, migrationsDirectory);
        for (const play of input) insertPlay(connection, play);
        output = serializeAnalyticalResult(
          generateArtistEraAnalysis({
            connection,
            parameters,
            presentationTimezone: "America/Chicago",
          }),
        );
      });
      return output;
    };
    assert.equal(render(history), render([...history].reverse()));
  });

  it("returns an empty, coverage-disclosed result for an empty canonical history", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const result = generateArtistEraAnalysis({
        connection,
        presentationTimezone: "America/Chicago",
      });
      assert.equal(result.asOf, null);
      assert.equal(result.dateRange, null);
      assert.deepEqual(result.result.intervals, []);
      assert.deepEqual(result.metadataCoverage.spotifySource, {
        availableEventCount: 0,
        rate: 0,
        totalEventCount: 0,
      });
    });
  });
});
