import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANALYTICAL_EXPORT_DIRECTORY_NAME,
  AnalyticalExportError,
  generateAnalyticalExports,
  verifyAnalyticalExports,
  writeAnalyticalExports,
} from "../../../src/exports/analytics.ts";
import type { SqliteConnection } from "../../../src/db/connection.ts";
import { withTemporaryTestWorkspace } from "../../helpers/temporary-workspace.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

function addGenreEvidence(connection: SqliteConnection): void {
  connection
    .prepare(
      "INSERT INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '11')",
    )
    .run();
  connection
    .prepare(
      "INSERT INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (1, 'artist', 1), (2, 'track', 1)",
    )
    .run();
  connection
    .prepare("INSERT INTO artist (id, preferred_name) VALUES (1, 'Synthetic Artist')")
    .run();
  connection
    .prepare("INSERT INTO track (id, artist_id, preferred_title) VALUES (2, 1, 'Synthetic Track')")
    .run();
  connection
    .prepare(
      "INSERT INTO listening_event (id, track_id, started_at_epoch_ms, ended_at_epoch_ms, time_basis, event_status, reconciliation_rule_version) VALUES (1, 2, 1, 1, 'observed_start', 'current', 'synthetic-v1')",
    )
    .run();
  connection
    .prepare(
      "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (1, 'lastfm', 1, 1)",
    )
    .run();
  connection
    .prepare(
      "INSERT INTO lastfm_scrobble_source (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name, source_fingerprint_sha256) VALUES (1, 'export', 1, 'Synthetic Artist', 'Synthetic Track', '0000000000000000000000000000000000000000000000000000000000000001')",
    )
    .run();
  connection
    .prepare(
      "INSERT INTO lastfm_scrobble_occurrence (source_record_id, lastfm_scrobble_source_record_id, source_origin) VALUES (1, 1, 'export')",
    )
    .run();
  connection
    .prepare(
      "INSERT INTO listening_event_source (listening_event_id, source_record_id, evidence_role) VALUES (1, 1, 'primary')",
    )
    .run();
  connection
    .prepare(
      "INSERT INTO music_identifier (entity_id, namespace, identifier_value, is_strong) VALUES (1, 'musicbrainz_artist_id', 'c0ffee00-cafe-4000-8000-000000000001', 1)",
    )
    .run();
  const snapshotId = Number(
    connection
      .prepare(
        "INSERT INTO genre_enrichment_snapshot (artist_id, provider, provider_entity_id, provider_response_schema_version, contract_version, provider_license, provider_attribution, fetched_at_epoch_ms, cache_state, outcome) VALUES (1, 'musicbrainz', 'c0ffee00-cafe-4000-8000-000000000001', 'musicbrainz-artist-v1', 'genre-evidence-v1', 'CC0 / CC BY-NC-SA', 'MusicBrainz', 0, 'success', 'success')",
      )
      .run().lastInsertRowid,
  );
  connection
    .prepare(
      "INSERT INTO genre_enrichment_raw_tag (snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre) VALUES (?, 'ambient', 'ambient', 1, NULL, 1)",
    )
    .run([snapshotId]);
}

describe("versioned analytical exports", () => {
  it("writes deterministic artifacts with manifest hashes and no raw source-table data", () => {
    withTemporaryTestWorkspace((workspace) => {
      const options = {
        connection: workspace.connection,
        migrationsDirectory,
        presentationTimezone: "America/Chicago",
      };
      const first = generateAnalyticalExports(options);
      const directory = writeAnalyticalExports(
        workspace.configuration.paths.outputsDirectory,
        first,
      );
      const manifestPath = path.join(directory, "manifest.json");
      const before = readFileSync(manifestPath, "utf8");
      const second = generateAnalyticalExports(options);
      writeAnalyticalExports(workspace.configuration.paths.outputsDirectory, second);

      assert.equal(
        directory,
        path.join(workspace.configuration.paths.outputsDirectory, ANALYTICAL_EXPORT_DIRECTORY_NAME),
      );
      assert.equal(readFileSync(manifestPath, "utf8"), before);
      assert.deepEqual(Object.keys(first.manifest.artifacts).sort(), [
        "abandonment",
        "artist-eras",
        "coverage",
        "genre-eras",
        "rediscovery",
        "volume",
      ]);
      for (const name of Object.keys(first.manifest.artifacts)) {
        const artifact = readFileSync(path.join(directory, `${name}.json`), "utf8");
        assert.equal(artifact.includes("source_record"), false);
        assert.equal(artifact.includes("raw_payload"), false);
      }
      assert.equal(existsSync(path.join(directory, "coverage.json")), true);
      assert.deepEqual(
        verifyAnalyticalExports(workspace.configuration.paths.outputsDirectory, options),
        first.manifest,
      );
    });
  });

  it("detects a stale bundle after aggregate coverage inputs change", () => {
    withTemporaryTestWorkspace((workspace) => {
      const options = {
        connection: workspace.connection,
        migrationsDirectory,
        presentationTimezone: "America/Chicago",
      };
      writeAnalyticalExports(
        workspace.configuration.paths.outputsDirectory,
        generateAnalyticalExports(options),
      );
      workspace.connection
        .prepare(
          "INSERT INTO ingest_run (command_type, started_at_epoch_ms, status, schema_version) VALUES ('identity_resolution', 1, 'running', '11')",
        )
        .run();
      workspace.connection
        .prepare(
          "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (1, 'spotify', 1, 1)",
        )
        .run();
      workspace.connection
        .prepare(
          "INSERT INTO spotify_play_source (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri, artist_name, track_name, shuffle, source_fingerprint_sha256) VALUES (1, 1, 1, 'spotify:track:synthetic', 'Synthetic Artist', 'Synthetic Track', 0, '0000000000000000000000000000000000000000000000000000000000000000')",
        )
        .run();

      assert.throws(
        () => verifyAnalyticalExports(workspace.configuration.paths.outputsDirectory, options),
        (error: unknown) => error instanceof AnalyticalExportError && error.code === "stale_export",
      );
    });
  });

  it("detects a stale bundle after genre evidence changes", () => {
    withTemporaryTestWorkspace((workspace) => {
      const options = {
        connection: workspace.connection,
        migrationsDirectory,
        presentationTimezone: "America/Chicago",
      };
      addGenreEvidence(workspace.connection);
      const generated = generateAnalyticalExports(options);
      writeAnalyticalExports(workspace.configuration.paths.outputsDirectory, generated);
      const priorSnapshotId = Number(
        workspace.connection
          .prepare<{ readonly id: number }>(
            "SELECT id FROM genre_enrichment_snapshot WHERE artist_id = 1",
          )
          .get()?.id,
      );
      const refreshedSnapshotId = Number(
        workspace.connection
          .prepare(
            "INSERT INTO genre_enrichment_snapshot (artist_id, provider, provider_entity_id, provider_response_schema_version, contract_version, provider_license, provider_attribution, fetched_at_epoch_ms, cache_state, outcome, supersedes_snapshot_id) VALUES (1, 'musicbrainz', 'c0ffee00-cafe-4000-8000-000000000001', 'musicbrainz-artist-v1', 'genre-evidence-v1', 'CC0 / CC BY-NC-SA', 'MusicBrainz', 1, 'success', 'success', ?)",
          )
          .run([priorSnapshotId]).lastInsertRowid,
      );
      workspace.connection
        .prepare(
          "INSERT INTO genre_enrichment_raw_tag (snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre) VALUES (?, 'jazz', 'jazz', 1, NULL, 1)",
        )
        .run([refreshedSnapshotId]);
      const changed = generateAnalyticalExports(options);

      assert.notEqual(
        changed.manifest.databaseState.genreEvidenceSnapshotSha256,
        generated.manifest.databaseState.genreEvidenceSnapshotSha256,
      );
      assert.throws(
        () => verifyAnalyticalExports(workspace.configuration.paths.outputsDirectory, options),
        (error: unknown) => error instanceof AnalyticalExportError && error.code === "stale_export",
      );
    });
  });

  it("retains the prior verified bundle when staging a replacement fails", () => {
    withTemporaryTestWorkspace((workspace) => {
      const options = {
        connection: workspace.connection,
        migrationsDirectory,
        presentationTimezone: "America/Chicago",
      };
      const generated = generateAnalyticalExports(options);
      const directory = writeAnalyticalExports(
        workspace.configuration.paths.outputsDirectory,
        generated,
      );
      const manifestPath = path.join(directory, "manifest.json");
      const originalManifest = readFileSync(manifestPath, "utf8");
      let writeCount = 0;

      assert.throws(() =>
        writeAnalyticalExports(workspace.configuration.paths.outputsDirectory, generated, {
          existsSync,
          mkdirSync,
          mkdtempSync,
          renameSync,
          rmSync,
          writeFileSync(file, data, options) {
            writeCount += 1;
            if (writeCount === 2) throw new Error("synthetic write failure");
            writeFileSync(file, data, options);
          },
        }),
      );

      assert.equal(readFileSync(manifestPath, "utf8"), originalManifest);
      assert.deepEqual(
        verifyAnalyticalExports(workspace.configuration.paths.outputsDirectory, options),
        generated.manifest,
      );
    });
  });

  it("rejects every malformed artifact even when its manifest digest is updated", () => {
    withTemporaryTestWorkspace((workspace) => {
      const options = {
        connection: workspace.connection,
        migrationsDirectory,
        presentationTimezone: "America/Chicago",
      };
      const generated = generateAnalyticalExports(options);
      const directory = writeAnalyticalExports(
        workspace.configuration.paths.outputsDirectory,
        generated,
      );

      for (const name of Object.keys(generated.manifest.artifacts)) {
        writeAnalyticalExports(workspace.configuration.paths.outputsDirectory, generated);
        const artifactPath = path.join(directory, `${name}.json`);
        const malformedArtifact = {
          artifact: name,
          databaseState: generated.manifest.databaseState,
          data: {},
          schemaVersion: "analytical-export-artifact-v2",
        };
        const malformedText = `${JSON.stringify(malformedArtifact)}\n`;
        writeFileSync(artifactPath, malformedText, "utf8");
        const manifestPath = path.join(directory, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          artifacts: Record<string, { file: string; sha256: string }>;
        };
        manifest.artifacts[name] = {
          file: manifest.artifacts[name]?.file ?? `${name}.json`,
          sha256: createHash("sha256").update(malformedText).digest("hex"),
        };
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

        assert.throws(
          () => verifyAnalyticalExports(workspace.configuration.paths.outputsDirectory, options),
          (error: unknown) =>
            error instanceof AnalyticalExportError && error.code === "artifact_invalid",
          name,
        );
      }
    });
  });
});
