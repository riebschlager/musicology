import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../../../src/db/migrations.ts";
import type { SqliteConnection } from "../../../src/db/connection.ts";
import { createTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import {
  exportGenreTaxonomy,
  importGenreTaxonomy,
} from "../../../src/genre/taxonomy-persistence.ts";
import {
  canonicalizeGenreTaxonomyArtifact,
  type GenreTaxonomyArtifact,
} from "../../../src/genre/taxonomy.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

const artifact: GenreTaxonomyArtifact = {
  artifactVersion: "genre-taxonomy-v1",
  taxonomyVersion: "synthetic-v1",
  categories: [
    { id: "rock", label: "Rock", parentId: null },
    { id: "dream-pop", label: "Dream Pop", parentId: "rock" },
  ],
  mappings: [
    { sourceTag: "dream pop", action: "rename", targetCategoryId: "dream-pop" },
    { sourceTag: "shoegaze", action: "combine", targetCategoryId: "dream-pop" },
    { sourceTag: "seen-but-ignored", action: "ignore", targetCategoryId: null },
  ],
};

function createSuccessfulSnapshot(connection: SqliteConnection): number {
  const artistId = Number(
    connection
      .prepare("INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('artist', 0)")
      .run().lastInsertRowid,
  );
  connection
    .prepare("INSERT INTO artist (id, preferred_name) VALUES (?, 'Synthetic Artist')")
    .run([artistId]);
  const providerEntityId = "c0ffee00-cafe-4000-8000-000000000001";
  connection
    .prepare(
      "INSERT INTO music_identifier (entity_id, namespace, identifier_value, is_strong) VALUES (?, 'musicbrainz_artist_id', ?, 1)",
    )
    .run([artistId, providerEntityId]);
  return Number(
    connection
      .prepare(
        "INSERT INTO genre_enrichment_snapshot (artist_id, provider, provider_entity_id, provider_response_schema_version, contract_version, provider_license, provider_attribution, fetched_at_epoch_ms, cache_state, outcome) VALUES (?, 'musicbrainz', ?, 'musicbrainz-artist-v1', 'genre-evidence-v1', 'CC0 / CC BY-NC-SA', 'MusicBrainz', 0, 'success', 'success')",
      )
      .run([artistId, providerEntityId]).lastInsertRowid,
  );
}

function insertRawTag(connection: SqliteConnection, snapshotId: number, tag: string): void {
  connection
    .prepare(
      "INSERT INTO genre_enrichment_raw_tag (snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre) VALUES (?, ?, ?, 1, NULL, 0)",
    )
    .run([snapshotId, tag, tag]);
}

describe("P5-05 taxonomy persistence", () => {
  it("round-trips a deterministic portable mapping artifact", () => {
    const database = createTemporarySqliteDatabase();
    try {
      applyMigrations(database.connection, migrationsDirectory);
      const snapshotId = createSuccessfulSnapshot(database.connection);
      for (const mapping of artifact.mappings)
        insertRawTag(database.connection, snapshotId, mapping.sourceTag);
      assert.deepEqual(importGenreTaxonomy(database.connection, artifact, 100), {
        taxonomyVersion: "synthetic-v1",
        imported: true,
      });
      assert.deepEqual(
        exportGenreTaxonomy(database.connection, "synthetic-v1"),
        canonicalizeGenreTaxonomyArtifact(artifact),
      );
      assert.deepEqual(importGenreTaxonomy(database.connection, artifact, 200), {
        taxonomyVersion: "synthetic-v1",
        imported: false,
      });
      assert.equal(database.connection.checkIntegrity().ok, true);
    } finally {
      database.cleanup();
    }
  });

  it("imports a valid hierarchy when children precede their parents in the artifact", () => {
    const database = createTemporarySqliteDatabase();
    try {
      applyMigrations(database.connection, migrationsDirectory);
      const snapshotId = createSuccessfulSnapshot(database.connection);
      for (const mapping of artifact.mappings)
        insertRawTag(database.connection, snapshotId, mapping.sourceTag);
      const childFirstArtifact = {
        ...artifact,
        taxonomyVersion: "synthetic-child-first-v1",
        categories: [...artifact.categories].reverse(),
      };

      assert.deepEqual(importGenreTaxonomy(database.connection, childFirstArtifact, 100), {
        taxonomyVersion: "synthetic-child-first-v1",
        imported: true,
      });
      assert.deepEqual(
        exportGenreTaxonomy(database.connection, "synthetic-child-first-v1"),
        canonicalizeGenreTaxonomyArtifact(childFirstArtifact),
      );
      assert.equal(database.connection.checkIntegrity().ok, true);
    } finally {
      database.cleanup();
    }
  });

  it("rejects unknown raw tags and requires a new version for changed taxonomy content without rewriting evidence", () => {
    const database = createTemporarySqliteDatabase();
    try {
      applyMigrations(database.connection, migrationsDirectory);
      assert.throws(
        () => importGenreTaxonomy(database.connection, artifact, 100),
        /unknown raw tag/u,
      );
      const snapshotId = createSuccessfulSnapshot(database.connection);
      for (const mapping of artifact.mappings)
        insertRawTag(database.connection, snapshotId, mapping.sourceTag);
      importGenreTaxonomy(database.connection, artifact, 100);
      assert.throws(
        () =>
          importGenreTaxonomy(
            database.connection,
            {
              ...artifact,
              categories: [
                { id: "rock", label: "Changed", parentId: null },
                { id: "dream-pop", label: "Dream Pop", parentId: "rock" },
              ],
            },
            200,
          ),
        /new taxonomy version/u,
      );
      const changed = {
        ...artifact,
        taxonomyVersion: "synthetic-v2",
        categories: [
          { id: "rock", label: "Changed", parentId: null },
          { id: "dream-pop", label: "Dream Pop", parentId: "rock" },
        ],
      };
      assert.equal(importGenreTaxonomy(database.connection, changed, 300).imported, true);
      assert.equal(
        database.connection.prepare("SELECT COUNT(*) AS count FROM genre_enrichment_raw_tag").get()
          ?.count,
        3,
      );
      assert.equal(database.connection.checkIntegrity().ok, true);
    } finally {
      database.cleanup();
    }
  });
});
