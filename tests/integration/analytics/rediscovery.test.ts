import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { generateRediscoveryAnalysis } from "../../../src/analytics/rediscovery.ts";
import type { SqliteConnection } from "../../../src/db/connection.ts";
import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const DAY_MS = 86_400_000;
const origin = Date.parse("2024-01-01T18:00:00.000Z");

interface SyntheticPlay { readonly artist: string; readonly day: number; readonly id: number; readonly trackId?: number; }

function fingerprint(id: number): string { return id.toString(16).padStart(64, "0"); }
function artistIdFor(artist: string): number { return [...artist].reduce((sum, character) => sum * 31 + (character.codePointAt(0) ?? 0), 0) + 1; }

function insertPlay(connection: SqliteConnection, play: SyntheticPlay): void {
  const artistId = artistIdFor(play.artist);
  const trackId = play.trackId ?? play.id * 10 + 2;
  const sourceId = play.id * 100 + 1;
  const startedAt = origin + play.day * DAY_MS;
  connection.prepare("INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '11')").run();
  connection.prepare("INSERT OR IGNORE INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (?, 'artist', 1)").run([artistId]);
  connection.prepare("INSERT OR IGNORE INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (?, 'track', 1)").run([trackId]);
  connection.prepare("INSERT OR IGNORE INTO artist (id, preferred_name) VALUES (?, ?)").run([artistId, play.artist]);
  connection.prepare("INSERT OR IGNORE INTO track (id, artist_id, preferred_title) VALUES (?, ?, 'Synthetic Track')").run([trackId, artistId]);
  connection.prepare("INSERT INTO listening_event (id, track_id, started_at_epoch_ms, ended_at_epoch_ms, time_basis, event_status, reconciliation_rule_version) VALUES (?, ?, ?, ?, 'observed_start', 'current', 'canonical-event-v1')").run([play.id, trackId, startedAt, startedAt + 30_000]);
  connection.prepare("INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'lastfm', 1, 1)").run([sourceId]);
  connection.prepare("INSERT INTO lastfm_scrobble_source (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name, source_fingerprint_sha256) VALUES (?, 'export', 1, 'Synthetic Artist', 'Synthetic Track', ?)").run([sourceId, fingerprint(sourceId)]);
  connection.prepare("INSERT INTO lastfm_scrobble_occurrence (source_record_id, lastfm_scrobble_source_record_id, source_origin) VALUES (?, ?, 'export')").run([sourceId, sourceId]);
  connection.prepare("INSERT INTO listening_event_source (listening_event_id, source_record_id, evidence_role) VALUES (?, ?, 'primary')").run([play.id, sourceId]);
}

function history(artist: string, firstId: number, days: readonly number[]): readonly SyntheticPlay[] {
  return days.map((day, index) => ({ artist, day, id: firstId + index }));
}

const parameters = {
  absenceThresholdDays: 180, minimumPersistencePlayCount: 2, minimumPriorPlayCount: 5,
  minimumReturnPlayCount: 1, persistenceWindowDays: 90, returnWindowDays: 30, scope: "artist",
} as const;

describe("rediscovery analysis", () => {
  it("handles exact 90, 180, and 365-day thresholds while excluding never-important artists", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const plays = [
        ...history("Ninety", 1, [0, 1, 2, 3, 4, 94]),
        ...history("OneEighty", 20, [0, 1, 2, 3, 4, 184]),
        ...history("ThreeSixtyFive", 40, [0, 1, 2, 3, 4, 369]),
        ...history("Minor", 60, [0, 1, 2, 3, 184]),
        ...history("Observer", 80, [500]),
      ];
      for (const play of plays) insertPlay(connection, play);
      for (const threshold of [90, 180, 365]) {
        const result = generateRediscoveryAnalysis({ connection, parameters: { ...parameters, absenceThresholdDays: threshold }, presentationTimezone: "America/Chicago" });
        assert.equal(result.result.rediscoveries.some((item) => item.entityDisplayName === "Minor"), false);
        const expected = threshold === 90 ? "Ninety" : threshold === 180 ? "OneEighty" : "ThreeSixtyFive";
        assert.equal(result.result.rediscoveries.some((item) => item.entityDisplayName === expected), true);
      }
    });
  });

  it("classifies one-off, sustained, repeated, and era-beginning returns with their evidence", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const plays = [
        ...history("OneOff", 1, [0, 1, 2, 3, 4, 184]),
        ...history("Sustained", 20, [0, 1, 2, 3, 4, 184, 220, 230]),
        ...history("Repeated", 40, [0, 1, 2, 3, 4, 184, 220, 230, 414, 450, 460]),
        ...history("Era", 70, [0, 1, 2, 3, 4, 730, 731, 732, 733, 734, 735, 736, 737, 738, 739, 740, 741, 820, 821, 822, 823, 824, 825, 826, 827, 828, 829, 830, 831]),
        ...history("Observer", 200, [1_000]),
      ];
      for (const play of plays) insertPlay(connection, play);
      const result = generateRediscoveryAnalysis({ connection, parameters, presentationTimezone: "America/Chicago" });
      const returns = result.result.rediscoveries;
      assert.equal(returns.find((item) => item.entityDisplayName === "OneOff")?.classification, "one_off_return");
      assert.equal(returns.find((item) => item.entityDisplayName === "Sustained")?.classification, "sustained_rediscovery");
      const repeated = returns.filter((item) => item.entityDisplayName === "Repeated");
      assert.equal(repeated.length, 2);
      assert.equal(repeated.every((item) => item.persistence === "persistent"), true);
      const era = returns.find((item) => item.entityDisplayName === "Era");
      assert.equal(era?.classification, "return_beginning_new_era");
      assert.ok(era?.relatedEra);
      assert.equal(era?.priorPlayCount, 5);
      assert.equal(era?.gapDays, 726);
    });
  });

  it("marks a current return as open instead of claiming that persistence has been observed", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (const play of history("Current", 1, [0, 1, 2, 3, 4, 184])) insertPlay(connection, play);
      const result = generateRediscoveryAnalysis({ connection, parameters, presentationTimezone: "America/Chicago" });
      const current = result.result.rediscoveries[0];
      assert.equal(current?.persistence, "open");
      assert.equal(current?.returnWindowComplete, false);
    });
  });

  it("supports track scope independently of artist scope", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (const play of history("Track Artist", 1, [0, 1, 2, 3, 4, 184])) {
        insertPlay(connection, { ...play, trackId: 999 });
      }
      insertPlay(connection, { artist: "Observer", day: 500, id: 100 });
      const result = generateRediscoveryAnalysis({ connection, parameters: { ...parameters, scope: "track" }, presentationTimezone: "America/Chicago" });
      assert.equal(result.result.rediscoveries[0]?.scope, "track");
      assert.equal(result.result.rediscoveries[0]?.entityId, 999);
    });
  });
});
