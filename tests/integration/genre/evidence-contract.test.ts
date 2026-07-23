import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

function insertArtist(connection: Parameters<typeof applyMigrations>[0]): number {
  const entity = connection
    .prepare("INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('artist', 0)")
    .run();
  return Number(
    connection
      .prepare("INSERT INTO artist (id, preferred_name) VALUES (?, 'Synthetic Artist')")
      .run([entity.lastInsertRowid]).lastInsertRowid,
  );
}

function insertStrongMusicBrainzArtistIdentifier(
  connection: Parameters<typeof applyMigrations>[0],
  artistId: number,
  identifierValue: string = "c0ffee00-cafe-4000-8000-000000000001",
): void {
  connection
    .prepare(
      `INSERT INTO music_identifier (entity_id, namespace, identifier_value, is_strong)
       VALUES (?, 'musicbrainz_artist_id', ?, 1)`,
    )
    .run([artistId, identifierValue]);
}

function insertSnapshot(
  connection: Parameters<typeof applyMigrations>[0],
  artistId: number,
  overrides: Readonly<Record<string, unknown>> = {},
): number {
  const result = connection
    .prepare(
      `INSERT INTO genre_enrichment_snapshot (
        artist_id, provider, provider_entity_id, provider_response_schema_version, contract_version,
        provider_license, provider_attribution, fetched_at_epoch_ms, cache_state, outcome, error_code,
        supersedes_snapshot_id
      ) VALUES (
        @artistId, 'musicbrainz', @providerEntityId, 'musicbrainz-artist-v1', 'genre-evidence-v1',
        'CC0 / CC BY-NC-SA', 'MusicBrainz', @fetchedAtEpochMs, @cacheState, @outcome, @errorCode,
        @supersedesSnapshotId
      )`,
    )
    .run({
      artistId,
      providerEntityId: "c0ffee00-cafe-4000-8000-000000000001",
      fetchedAtEpochMs: 1_700_000_000_000,
      cacheState: "success",
      outcome: "success",
      errorCode: null,
      supersedesSnapshotId: null,
      ...overrides,
    });
  return Number(result.lastInsertRowid);
}

describe("genre enrichment evidence schema", () => {
  it("preserves versioned provider snapshots, raw weights, freshness, and lineage", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const artistId = insertArtist(connection);
      insertStrongMusicBrainzArtistIdentifier(connection, artistId);
      const firstSnapshotId = insertSnapshot(connection, artistId);
      const refreshedSnapshotId = insertSnapshot(connection, artistId, {
        fetchedAtEpochMs: 1_700_000_000_001,
        supersedesSnapshotId: firstSnapshotId,
      });
      connection
        .prepare(
          `INSERT INTO genre_enrichment_raw_tag (
            snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre
          ) VALUES (?, 'Dream Pop', 'dream pop', 12, NULL, 1)`,
        )
        .run([refreshedSnapshotId]);

      assert.deepEqual(
        connection
          .prepare(
            `SELECT snapshot.provider, snapshot.fetched_at_epoch_ms, snapshot.supersedes_snapshot_id,
                    tag.raw_weight, tag.confidence, tag.is_recognized_genre
               FROM genre_enrichment_snapshot AS snapshot
               JOIN genre_enrichment_raw_tag AS tag ON tag.snapshot_id = snapshot.id
              WHERE snapshot.id = ?`,
          )
          .get([refreshedSnapshotId]),
        {
          provider: "musicbrainz",
          fetched_at_epoch_ms: 1_700_000_000_001,
          supersedes_snapshot_id: firstSnapshotId,
          raw_weight: 12,
          confidence: null,
          is_recognized_genre: 1,
        },
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

  it("retains snapshots and raw tags when direct or cascading deletion is attempted", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const artistId = insertArtist(connection);
      insertStrongMusicBrainzArtistIdentifier(connection, artistId);
      const snapshotId = insertSnapshot(connection, artistId);
      connection
        .prepare(
          `INSERT INTO genre_enrichment_raw_tag (
            snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre
          ) VALUES (?, 'Dream Pop', 'dream pop', 12, NULL, 1)`,
        )
        .run([snapshotId]);

      assert.throws(() =>
        connection
          .prepare("DELETE FROM genre_enrichment_raw_tag WHERE snapshot_id = ?")
          .run([snapshotId]),
      );
      assert.throws(() =>
        connection.prepare("DELETE FROM genre_enrichment_snapshot WHERE id = ?").run([snapshotId]),
      );
      assert.throws(() => connection.prepare("DELETE FROM artist WHERE id = ?").run([artistId]));
      assert.deepEqual(
        connection
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM genre_enrichment_snapshot) AS snapshot_count,
               (SELECT COUNT(*) FROM genre_enrichment_raw_tag) AS raw_tag_count`,
          )
          .get(),
        { snapshot_count: 1, raw_tag_count: 1 },
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

  it("requires the artist exact strong MusicBrainz identifier", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const artistId = insertArtist(connection);

      assert.throws(() => insertSnapshot(connection, artistId));

      const exactIdentifier = "c0ffee00-cafe-4000-8000-000000000002";
      insertStrongMusicBrainzArtistIdentifier(connection, artistId, exactIdentifier);
      assert.throws(() => insertSnapshot(connection, artistId));
      assert.doesNotThrow(() =>
        insertSnapshot(connection, artistId, { providerEntityId: exactIdentifier }),
      );
    });
  });

  it("retains failure metadata without raw evidence or replacing a successful snapshot", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      const firstArtistId = insertArtist(connection);
      const secondArtistId = insertArtist(connection);
      insertStrongMusicBrainzArtistIdentifier(connection, firstArtistId);
      const secondArtistIdentifier = "c0ffee00-cafe-4000-8000-000000000002";
      insertStrongMusicBrainzArtistIdentifier(connection, secondArtistId, secondArtistIdentifier);
      const successfulSnapshotId = insertSnapshot(connection, firstArtistId);
      const failureSnapshotId = insertSnapshot(connection, firstArtistId, {
        fetchedAtEpochMs: 1_700_000_000_001,
        cacheState: "failure",
        outcome: "temporary_failure",
        errorCode: "timeout",
      });
      assert.throws(() =>
        connection
          .prepare(
            `INSERT INTO genre_enrichment_raw_tag (
              snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre
            ) VALUES (?, 'Should Fail', 'should fail', 1, NULL, 0)`,
          )
          .run([failureSnapshotId]),
      );
      assert.throws(() =>
        insertSnapshot(connection, firstArtistId, {
          fetchedAtEpochMs: 1_700_000_000_002,
          cacheState: "failure",
          outcome: "temporary_failure",
          errorCode: "timeout",
          supersedesSnapshotId: successfulSnapshotId,
        }),
      );
      assert.throws(() =>
        insertSnapshot(connection, secondArtistId, {
          fetchedAtEpochMs: 1_700_000_000_003,
          providerEntityId: secondArtistIdentifier,
          supersedesSnapshotId: successfulSnapshotId,
        }),
      );
      assert.deepEqual(
        connection
          .prepare(
            `SELECT id, cache_state, supersedes_snapshot_id
               FROM genre_enrichment_snapshot
              WHERE artist_id = ?
              ORDER BY id`,
          )
          .all([firstArtistId]),
        [
          { id: successfulSnapshotId, cache_state: "success", supersedes_snapshot_id: null },
          { id: failureSnapshotId, cache_state: "failure", supersedes_snapshot_id: null },
        ],
      );
    });
  });
});
