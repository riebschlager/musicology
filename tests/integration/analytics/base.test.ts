import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_ANALYTICAL_BASE_QUERY_VERSION,
  queryCanonicalAnalyticalBase,
} from "../../../src/analytics/base.ts";
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
    readonly eventId: number;
    readonly eventStatus?: "current" | "unresolved";
    readonly lastfm?: boolean;
    readonly spotify?: boolean;
    readonly startedAt: string;
  },
): void {
  const eventId = options.eventId;
  const artistId = eventId * 10 + 1;
  const trackId = eventId * 10 + 2;
  const startedAtEpochMs = Date.parse(options.startedAt);
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
    .run([artistId, `Artist ${eventId}`]);
  connection
    .prepare("INSERT INTO track (id, artist_id, preferred_title) VALUES (?, ?, ?)")
    .run([trackId, artistId, `Track ${eventId}`]);
  connection
    .prepare(
      `INSERT INTO listening_event
        (id, track_id, started_at_epoch_ms, ended_at_epoch_ms, listened_ms, time_basis, event_status,
         reconciliation_rule_version)
       VALUES (?, ?, ?, ?, ?, 'observed_start', ?, 'canonical-event-v1')`,
    )
    .run([
      eventId,
      trackId,
      startedAtEpochMs,
      startedAtEpochMs + 30_000,
      options.spotify ? 30_000 : null,
      options.eventStatus ?? "current",
    ]);
  if (options.spotify) {
    const sourceRecordId = eventId * 100 + 1;
    connection
      .prepare(
        "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'spotify', 1, 1)",
      )
      .run([sourceRecordId]);
    connection
      .prepare(
        `INSERT INTO spotify_play_source
          (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri, artist_name, track_name,
           shuffle, source_fingerprint_sha256)
         VALUES (?, 1, 30000, ?, 'Synthetic Artist', 'Synthetic Track', 0, ?)`,
      )
      .run([sourceRecordId, `spotify:track:${eventId}`, fingerprint(sourceRecordId)]);
    connection
      .prepare(
        "INSERT INTO listening_event_source (listening_event_id, source_record_id, evidence_role) VALUES (?, ?, 'primary')",
      )
      .run([eventId, sourceRecordId]);
  }
  if (options.lastfm) {
    const sourceRecordId = eventId * 100 + 2;
    connection
      .prepare(
        "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'lastfm', 1, 1)",
      )
      .run([sourceRecordId]);
    connection
      .prepare(
        `INSERT INTO lastfm_scrobble_source
          (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name,
           source_fingerprint_sha256)
         VALUES (?, 'export', 1, 'Synthetic Artist', 'Synthetic Track', ?)`,
      )
      .run([sourceRecordId, fingerprint(sourceRecordId)]);
    connection
      .prepare(
        "INSERT INTO lastfm_scrobble_occurrence (source_record_id, lastfm_scrobble_source_record_id, source_origin) VALUES (?, ?, 'export')",
      )
      .run([sourceRecordId, sourceRecordId]);
    connection
      .prepare(
        "INSERT INTO listening_event_source (listening_event_id, source_record_id, evidence_role) VALUES (?, ?, 'primary')",
      )
      .run([eventId, sourceRecordId]);
  }
}

describe("canonical analytical base", () => {
  it("projects a UTC day boundary in explicitly supplied America/Chicago time", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertEvent(connection, { eventId: 1, spotify: true, startedAt: "2026-01-01T05:59:59.999Z" });
      insertEvent(connection, { eventId: 2, lastfm: true, startedAt: "2026-01-01T06:00:00.000Z" });

      const events = queryCanonicalAnalyticalBase(connection, "America/Chicago");
      assert.equal(CANONICAL_ANALYTICAL_BASE_QUERY_VERSION, "canonical-analytical-base-v1");
      assert.deepEqual(
        events.map((event) => event.calendar),
        [
          {
            day: "2025-12-31",
            isoWeek: "2026-W01",
            month: "2025-12",
            quarter: "2025-Q4",
            year: "2025",
          },
          {
            day: "2026-01-01",
            isoWeek: "2026-W01",
            month: "2026-01",
            quarter: "2026-Q1",
            year: "2026",
          },
        ],
      );
    });
  });

  it("uses the caller's alternate timezone rather than machine-local grouping", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertEvent(connection, { eventId: 1, lastfm: true, startedAt: "2026-01-01T00:30:00.000Z" });

      assert.equal(
        queryCanonicalAnalyticalBase(connection, "America/Chicago")[0]?.calendar.day,
        "2025-12-31",
      );
      assert.equal(
        queryCanonicalAnalyticalBase(connection, "Pacific/Auckland")[0]?.calendar.day,
        "2026-01-01",
      );
      assert.throws(() => queryCanonicalAnalyticalBase(connection, ""), /valid IANA timezone/);
    });
  });

  it("counts a multi-source event once and retains unresolved and Spotify-duration coverage flags", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertEvent(connection, {
        eventId: 1,
        lastfm: true,
        spotify: true,
        startedAt: "2026-02-01T12:00:00.000Z",
      });
      insertEvent(connection, {
        eventId: 2,
        eventStatus: "unresolved",
        lastfm: true,
        startedAt: "2026-02-02T12:00:00.000Z",
      });

      const events = queryCanonicalAnalyticalBase(connection, "America/Chicago");
      assert.equal(events.length, 2);
      assert.deepEqual(
        {
          hasLastfmSource: events[0]?.hasLastfmSource,
          hasSpotifySource: events[0]?.hasSpotifySource,
          reconciliationStatus: events[0]?.reconciliationStatus,
          sourceRecordCount: events[0]?.sourceRecordCount,
          spotifyDurationMs: events[0]?.spotifyDurationMs,
        },
        {
          hasLastfmSource: true,
          hasSpotifySource: true,
          reconciliationStatus: "cross_source_reconciled",
          sourceRecordCount: 2,
          spotifyDurationMs: 30000,
        },
      );
      assert.deepEqual(
        {
          canonicalListenedMs: events[1]?.canonicalListenedMs,
          eventStatus: events[1]?.eventStatus,
          hasLastfmSource: events[1]?.hasLastfmSource,
          hasSpotifySource: events[1]?.hasSpotifySource,
          reconciliationStatus: events[1]?.reconciliationStatus,
          spotifyDurationMs: events[1]?.spotifyDurationMs,
        },
        {
          canonicalListenedMs: null,
          eventStatus: "unresolved",
          hasLastfmSource: true,
          hasSpotifySource: false,
          reconciliationStatus: "unresolved",
          spotifyDurationMs: null,
        },
      );
    });
  });
});
