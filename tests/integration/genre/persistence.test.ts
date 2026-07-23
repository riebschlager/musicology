import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../../../src/db/migrations.ts";
import type { SqliteConnection } from "../../../src/db/connection.ts";
import {
  generateGenreEnrichmentCoverage,
  genreEnrichmentTargets,
} from "../../../src/genre/coverage.ts";
import type { GenreEnrichmentSnapshot } from "../../../src/genre/evidence-contract.ts";
import { SqliteGenreEnrichmentSnapshotCache } from "../../../src/genre/persistence.ts";
import { createTemporarySqliteDatabase } from "../../../src/db/temporary.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

function insertArtist(connection: SqliteConnection, eventCount: number): number {
  const artist = connection
    .prepare("INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('artist', 0)")
    .run();
  const artistId = Number(artist.lastInsertRowid);
  connection
    .prepare("INSERT INTO artist (id, preferred_name) VALUES (?, 'Synthetic Artist')")
    .run([artistId]);
  const track = connection
    .prepare("INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('track', 0)")
    .run();
  const trackId = Number(track.lastInsertRowid);
  connection
    .prepare("INSERT INTO track (id, artist_id, preferred_title) VALUES (?, ?, 'Synthetic Track')")
    .run([trackId, artistId]);
  const insertEvent = connection.prepare(
    `INSERT INTO listening_event (
      track_id, started_at_epoch_ms, ended_at_epoch_ms, time_basis, event_status,
      reconciliation_rule_version
    ) VALUES (?, ?, ?, 'observed_start', 'current', 'synthetic-v1')`,
  );
  for (let index = 0; index < eventCount; index += 1) {
    insertEvent.run([trackId, index, index]);
  }
  return artistId;
}

function addStrongIdentifier(
  connection: SqliteConnection,
  artistId: number,
  suffix: string,
): string {
  const identifier = `c0ffee00-cafe-4000-8000-${suffix.padStart(12, "0")}`;
  connection
    .prepare(
      `INSERT INTO music_identifier (entity_id, namespace, identifier_value, is_strong)
       VALUES (?, 'musicbrainz_artist_id', ?, 1)`,
    )
    .run([artistId, identifier]);
  return identifier;
}

function snapshot(
  artistId: number,
  providerEntityId: string,
  fetchedAtEpochMs: number,
  overrides: Partial<GenreEnrichmentSnapshot> = {},
): GenreEnrichmentSnapshot {
  return {
    artistId,
    provider: "musicbrainz",
    providerEntityId,
    providerResponseSchemaVersion: "musicbrainz-artist-v1",
    contractVersion: "genre-evidence-v1",
    providerLicense: "CC0 / CC BY-NC-SA",
    providerAttribution: "MusicBrainz",
    fetchedAtEpochMs,
    cacheState: "success",
    outcome: "success",
    errorCode: null,
    supersedesSnapshotId: null,
    rawTags: [
      {
        rawTagName: "Dream Pop",
        normalizedRawTag: "dream pop",
        rawWeight: 2,
        confidence: null,
        isRecognizedGenre: true,
      },
    ],
    ...overrides,
  };
}

describe("P5-04 genre enrichment persistence and coverage", () => {
  it("persists raw evidence idempotently and retains refresh lineage", async () => {
    const database = createTemporarySqliteDatabase();
    try {
      const { connection } = database;
      applyMigrations(connection, migrationsDirectory);
      const artistId = insertArtist(connection, 1);
      const identifier = addStrongIdentifier(connection, artistId, "1");
      const cache = new SqliteGenreEnrichmentSnapshotCache(connection);
      const first = snapshot(artistId, identifier, 100);

      const stored = await cache.record(first);
      const rerun = await cache.record(first);
      assert.equal(rerun.snapshotId, stored.snapshotId);
      assert.equal(
        connection.prepare("SELECT COUNT(*) AS count FROM genre_enrichment_snapshot").get()?.count,
        1,
      );
      assert.deepEqual(
        (await cache.latest({ artistId, musicbrainzArtistId: identifier }))?.snapshot,
        first,
      );

      const refreshed = snapshot(artistId, identifier, 200, {
        supersedesSnapshotId: stored.snapshotId,
      });
      const refreshedStored = await cache.record(refreshed);
      assert.equal(refreshedStored.snapshot.supersedesSnapshotId, stored.snapshotId);
      assert.equal(connection.checkIntegrity().ok, true);
    } finally {
      database.cleanup();
    }
  });

  it("rolls back the snapshot when a raw-tag write fails", async () => {
    const database = createTemporarySqliteDatabase();
    try {
      const { connection } = database;
      applyMigrations(connection, migrationsDirectory);
      const artistId = insertArtist(connection, 1);
      const identifier = addStrongIdentifier(connection, artistId, "rollback");
      connection.execute(`
        CREATE TRIGGER fail_genre_enrichment_raw_tag_insert
        BEFORE INSERT ON genre_enrichment_raw_tag
        BEGIN
          SELECT RAISE(ABORT, 'synthetic raw-tag failure');
        END;
      `);

      await assert.rejects(
        new SqliteGenreEnrichmentSnapshotCache(connection).record(
          snapshot(artistId, identifier, 100),
        ),
        /synthetic raw-tag failure/u,
      );
      assert.equal(
        connection.prepare("SELECT COUNT(*) AS count FROM genre_enrichment_snapshot").get()?.count,
        0,
      );
      assert.equal(
        connection.prepare("SELECT COUNT(*) AS count FROM genre_enrichment_raw_tag").get()?.count,
        0,
      );
      assert.equal(connection.checkIntegrity().ok, true);
    } finally {
      database.cleanup();
    }
  });

  it("keeps ambiguous IDs unresolved and reconciles coverage artist and event counts", async () => {
    const database = createTemporarySqliteDatabase();
    try {
      const { connection } = database;
      applyMigrations(connection, migrationsDirectory);
      const enrichedArtist = insertArtist(connection, 3);
      const missingArtist = insertArtist(connection, 2);
      const ambiguousArtist = insertArtist(connection, 1);
      const staleArtist = insertArtist(connection, 2);
      const failedArtist = insertArtist(connection, 1);
      const enrichedId = addStrongIdentifier(connection, enrichedArtist, "2");
      addStrongIdentifier(connection, missingArtist, "3");
      const staleId = addStrongIdentifier(connection, staleArtist, "4");
      const failedId = addStrongIdentifier(connection, failedArtist, "5");
      const cache = new SqliteGenreEnrichmentSnapshotCache(connection);
      await cache.record(snapshot(enrichedArtist, enrichedId, 900));
      await cache.record(snapshot(staleArtist, staleId, 0));
      await cache.record(
        snapshot(failedArtist, failedId, 900, {
          cacheState: "failure",
          outcome: "temporary_failure",
          errorCode: "timeout",
          rawTags: [],
        }),
      );

      assert.deepEqual(genreEnrichmentTargets(connection), [
        { artistId: enrichedArtist, musicbrainzArtistId: enrichedId },
        { artistId: missingArtist, musicbrainzArtistId: "c0ffee00-cafe-4000-8000-000000000003" },
        { artistId: staleArtist, musicbrainzArtistId: staleId },
        { artistId: ambiguousArtist },
        { artistId: failedArtist, musicbrainzArtistId: failedId },
      ]);
      const coverage = generateGenreEnrichmentCoverage(connection, {
        now: () => 1_000,
        refreshAgeMs: 500,
      });
      assert.deepEqual(coverage.states, {
        enriched: { artistCount: 1, eventCount: 3 },
        missing: { artistCount: 1, eventCount: 2 },
        ambiguous: { artistCount: 1, eventCount: 1 },
        stale: { artistCount: 1, eventCount: 2 },
        failed: { artistCount: 1, eventCount: 1 },
      });
      assert.deepEqual(coverage.total, { artistCount: 5, eventCount: 9 });
      assert.equal(connection.checkIntegrity().ok, true);
    } finally {
      database.cleanup();
    }
  });

  it("does not count retained evidence for a replaced MusicBrainz identity", async () => {
    const database = createTemporarySqliteDatabase();
    try {
      const { connection } = database;
      applyMigrations(connection, migrationsDirectory);
      const artistId = insertArtist(connection, 2);
      const priorIdentifier = addStrongIdentifier(connection, artistId, "6");
      const cache = new SqliteGenreEnrichmentSnapshotCache(connection);
      await cache.record(snapshot(artistId, priorIdentifier, 900));

      connection
        .prepare(
          `DELETE FROM music_identifier
            WHERE entity_id = ? AND namespace = 'musicbrainz_artist_id'`,
        )
        .run([artistId]);
      const currentIdentifier = addStrongIdentifier(connection, artistId, "7");

      assert.deepEqual(genreEnrichmentTargets(connection), [
        { artistId, musicbrainzArtistId: currentIdentifier },
      ]);
      assert.deepEqual(generateGenreEnrichmentCoverage(connection, { now: () => 1_000 }).states, {
        enriched: { artistCount: 0, eventCount: 0 },
        missing: { artistCount: 1, eventCount: 2 },
        ambiguous: { artistCount: 0, eventCount: 0 },
        stale: { artistCount: 0, eventCount: 0 },
        failed: { artistCount: 0, eventCount: 0 },
      });
      assert.equal(
        connection.prepare("SELECT COUNT(*) AS count FROM genre_enrichment_snapshot").get()?.count,
        1,
      );
      assert.equal(connection.checkIntegrity().ok, true);
    } finally {
      database.cleanup();
    }
  });
});
