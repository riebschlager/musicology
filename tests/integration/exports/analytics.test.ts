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
import { withTemporaryTestWorkspace } from "../../helpers/temporary-workspace.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

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
          schemaVersion: "analytical-export-artifact-v1",
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
