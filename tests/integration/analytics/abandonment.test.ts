import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { generateAbandonmentAnalysis } from "../../../src/analytics/abandonment.ts";
import type { SqliteConnection } from "../../../src/db/connection.ts";
import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const DAY_MS = 86_400_000;
const origin = Date.parse("2024-01-01T18:00:00.000Z");

interface SyntheticPlay {
  readonly artist: string;
  readonly day: number;
  readonly id: number;
}

function fingerprint(id: number): string {
  return id.toString(16).padStart(64, "0");
}
function artistIdFor(artist: string): number {
  return [...artist].reduce((sum, character) => sum * 31 + (character.codePointAt(0) ?? 0), 0) + 1;
}
function asOf(day: number): string {
  return new Date(origin + day * DAY_MS).toISOString();
}

function insertPlay(connection: SqliteConnection, play: SyntheticPlay): void {
  const artistId = artistIdFor(play.artist);
  const trackId = play.id * 10 + 2;
  const sourceId = play.id * 100 + 1;
  const startedAt = origin + play.day * DAY_MS;
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
      "INSERT OR IGNORE INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (?, 'track', 1)",
    )
    .run([trackId]);
  connection
    .prepare("INSERT OR IGNORE INTO artist (id, preferred_name) VALUES (?, ?)")
    .run([artistId, play.artist]);
  connection
    .prepare(
      "INSERT OR IGNORE INTO track (id, artist_id, preferred_title) VALUES (?, ?, 'Synthetic Track')",
    )
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

function history(
  artist: string,
  firstId: number,
  days: readonly number[],
): readonly SyntheticPlay[] {
  return days.map((day, index) => ({ artist, day, id: firstId + index }));
}

describe("abandonment analysis", () => {
  it("excludes right-censored recent and historically minor artists", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (const play of [
        ...history("Recent", 1, [0, 1, 2, 3, 4]),
        ...history("Minor", 20, [0, 1, 2, 3]),
        ...history("Observer", 40, [183]),
      ])
        insertPlay(connection, play);
      const result = generateAbandonmentAnalysis({
        connection,
        presentationTimezone: "America/Chicago",
      });
      assert.equal(
        result.result.artists.some((artist) => artist.artistDisplayName === "Recent"),
        false,
      );
      assert.equal(
        result.result.artists.some((artist) => artist.artistDisplayName === "Minor"),
        false,
      );
    });
  });

  it("reports fully observed likely abandonment with cadence and active-period evidence", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (const play of [
        ...history("Dormant", 1, [0, 1, 2, 3, 4]),
        ...history("Likely", 20, [0, 1, 2, 3, 4, 200, 201, 202, 203, 204]),
        ...history("Observer", 40, [600]),
      ])
        insertPlay(connection, play);
      const result = generateAbandonmentAnalysis({
        connection,
        presentationTimezone: "America/Chicago",
      });
      const dormant = result.result.artists.find(
        (artist) => artist.artistDisplayName === "Dormant",
      );
      const likely = result.result.artists.find((artist) => artist.artistDisplayName === "Likely");
      assert.equal(dormant?.status, "likely_abandoned_as_of");
      assert.equal(likely?.formerCadencePlayCount, 5);
      assert.equal(likely?.lastActivePeriod.playCount, 5);
      assert.equal(likely?.activePeriodCount, 2);
      assert.equal(likely?.confidence.observationCompleteness, 1);
    });
  });

  it("uses likelyAbandonedDays independently of the observation window", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (const play of [
        ...history("Threshold", 1, [0, 1, 2, 3, 4]),
        ...history("Observer", 20, [400]),
      ])
        insertPlay(connection, play);

      const atDefaultThreshold = generateAbandonmentAnalysis({
        connection,
        parameters: { likelyAbandonedDays: 365, observationWindowDays: 365 },
        presentationTimezone: "America/Chicago",
      });
      const atLaterThreshold = generateAbandonmentAnalysis({
        connection,
        parameters: { likelyAbandonedDays: 500, observationWindowDays: 365 },
        presentationTimezone: "America/Chicago",
      });

      assert.equal(
        atDefaultThreshold.result.artists.find((artist) => artist.artistDisplayName === "Threshold")
          ?.status,
        "likely_abandoned_as_of",
      );
      assert.equal(
        atLaterThreshold.result.artists.find((artist) => artist.artistDisplayName === "Threshold")
          ?.status,
        "dormant",
      );
    });
  });

  it("classifies exact dormancy, likely-abandonment, and observation-window boundaries", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (const play of [
        ...history("Boundary", 1, [0, 1, 2, 3, 4]),
        ...history("Observer", 20, [500]),
      ])
        insertPlay(connection, play);

      const statusAt = (day: number, parameters: Record<string, number> = {}) =>
        generateAbandonmentAnalysis({
          connection,
          parameters: { ...parameters, asOf: asOf(day) },
          presentationTimezone: "America/Chicago",
        }).result.artists.find((artist) => artist.artistDisplayName === "Boundary")?.status;

      assert.equal(statusAt(183), undefined);
      assert.equal(statusAt(184), "dormant");

      const likelyBoundary = { likelyAbandonedDays: 365, observationWindowDays: 180 };
      assert.equal(statusAt(368, likelyBoundary), "dormant");
      assert.equal(statusAt(369, likelyBoundary), "likely_abandoned_as_of");

      const observationBoundary = { likelyAbandonedDays: 180, observationWindowDays: 365 };
      assert.equal(statusAt(368, observationBoundary), "dormant");
      assert.equal(statusAt(369, observationBoundary), "likely_abandoned_as_of");
    });
  });

  it("keeps a shorter, adequately observed absence as dormant", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (const play of [
        ...history("Dormant", 1, [0, 1, 2, 3, 4]),
        ...history("Observer", 20, [204]),
      ])
        insertPlay(connection, play);
      const result = generateAbandonmentAnalysis({
        connection,
        presentationTimezone: "America/Chicago",
      });
      const dormant = result.result.artists.find(
        (artist) => artist.artistDisplayName === "Dormant",
      );
      assert.equal(dormant?.status, "dormant");
      assert.equal(dormant?.observationDays, 200);
      assert.equal(dormant?.confidence.observationCompleteness, 200 / 365);
    });
  });

  it("lets a later rediscovery invalidate a prior as-of conclusion while retaining the prior result", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (const play of [
        ...history("Returned", 1, [0, 1, 2, 3, 4, 500]),
        ...history("Observer", 20, [370]),
      ])
        insertPlay(connection, play);
      const beforeReturn = generateAbandonmentAnalysis({
        connection,
        parameters: { asOf: asOf(370) },
        presentationTimezone: "America/Chicago",
      });
      const afterReturn = generateAbandonmentAnalysis({
        connection,
        parameters: { asOf: asOf(500) },
        presentationTimezone: "America/Chicago",
      });
      assert.equal(
        beforeReturn.result.artists.find((artist) => artist.artistDisplayName === "Returned")
          ?.status,
        "likely_abandoned_as_of",
      );
      assert.equal(
        afterReturn.result.artists.some((artist) => artist.artistDisplayName === "Returned"),
        false,
      );
      assert.equal(beforeReturn.asOf, new Date(Date.parse(asOf(370)) + 1).toISOString());
      assert.equal(afterReturn.asOf, new Date(Date.parse(asOf(500)) + 1).toISOString());
    });
  });

  it("uses an end-exclusive envelope as-of value for the default latest-event observation", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (const play of [
        ...history("Dormant", 1, [0, 1, 2, 3, 4]),
        ...history("Observer", 20, [370]),
      ])
        insertPlay(connection, play);

      const result = generateAbandonmentAnalysis({
        connection,
        presentationTimezone: "America/Chicago",
      });

      assert.equal(result.asOf, new Date(Date.parse(asOf(370)) + 1).toISOString());
      assert.equal(result.dateRange?.endExclusive, result.asOf);
      assert.equal(result.eventCount, 6);
    });
  });

  it("rejects invalid and forward-looking as-of parameters", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertPlay(connection, { artist: "Observer", day: 1, id: 1 });
      assert.throws(
        () =>
          generateAbandonmentAnalysis({
            connection,
            parameters: { dormancyDays: 366, likelyAbandonedDays: 365 },
            presentationTimezone: "America/Chicago",
          }),
        /dormancyDays/,
      );
      assert.throws(
        () =>
          generateAbandonmentAnalysis({
            connection,
            parameters: { asOf: asOf(2) },
            presentationTimezone: "America/Chicago",
          }),
        /asOf/,
      );
    });
  });
});
