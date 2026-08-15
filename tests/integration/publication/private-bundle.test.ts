import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  generateAnalyticalExports,
  writeAnalyticalExports,
} from "../../../src/exports/analytics.ts";
import type { SqliteConnection } from "../../../src/db/connection.ts";
import {
  loadPrivateAnalyticalBundle,
  PrivateBundleError,
} from "../../../src/publication/private-bundle.ts";
import { syntheticDatabaseState, writeSyntheticPrivateBundle } from "../../fixtures/publication.ts";
import { withTemporaryTestWorkspace } from "../../helpers/temporary-workspace.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "musicology-p6-04-bundle-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("P6-04 private analytical bundle adapter", () => {
  it("loads real deterministic exporter output for empty and populated synthetic databases", () => {
    for (const populated of [false, true]) {
      withTemporaryTestWorkspace((workspace) => {
        if (populated) addSyntheticCanonicalEvent(workspace.connection);
        const generated = generateAnalyticalExports({
          connection: workspace.connection,
          migrationsDirectory,
          presentationTimezone: "America/Chicago",
        });
        const directory = writeAnalyticalExports(
          workspace.configuration.paths.outputsDirectory,
          generated,
        );

        const loaded = loadPrivateAnalyticalBundle(directory, generated.manifest.databaseState);

        assert.equal(loaded.volume.eventCount, populated ? 1 : 0);
        assert.equal(loaded.coverage.canonical.eventCount, populated ? 1 : 0);
        assert.equal("generatedAt" in loaded.coverage, false);
        assert.deepEqual(loaded.manifest, generated.manifest);
      });
    }
  });

  it("loads all six verified artifacts without returning private file bytes", () => {
    withDirectory((directory) => {
      writeSyntheticPrivateBundle(directory);
      const loaded = loadPrivateAnalyticalBundle(directory, syntheticDatabaseState);

      assert.equal(loaded.volume.eventCount, 50);
      assert.equal(loaded.artistEras.result.intervals.length, 4);
      assert.equal(loaded.rediscovery.result.rediscoveries.length, 1);
      assert.equal(loaded.abandonment.result.artists.length, 1);
      assert.equal(loaded.coverage.canonical.eventCount, 50);
    });
  });

  it("rejects missing, stale, incompatible, and internally inconsistent inputs", () => {
    withDirectory((directory) => {
      assertPrivateError(
        () => loadPrivateAnalyticalBundle(directory, syntheticDatabaseState),
        "missing_private_bundle",
      );

      writeSyntheticPrivateBundle(directory);
      assertPrivateError(
        () =>
          loadPrivateAnalyticalBundle(directory, {
            ...syntheticDatabaseState,
            canonicalSnapshotSha256: "9".repeat(64),
          }),
        "stale_private_bundle",
      );

      const manifestPath = path.join(directory, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      writeFileSync(
        manifestPath,
        serialize({ ...manifest, schemaVersion: "unsupported-private-schema" }),
        "utf8",
      );
      assertPrivateError(
        () => loadPrivateAnalyticalBundle(directory, syntheticDatabaseState),
        "incompatible_private_bundle",
      );

      writeSyntheticPrivateBundle(directory);
      mutateArtifact(directory, "abandonment", (artifact) => ({
        ...artifact,
        data: { ...(artifact.data as object), eventCount: 29 },
      }));
      assertPrivateError(
        () => loadPrivateAnalyticalBundle(directory, syntheticDatabaseState),
        "inconsistent_private_bundle",
      );
    });
  });

  it("rejects unknown private wrapper fields with sanitized errors", () => {
    withDirectory((directory) => {
      writeSyntheticPrivateBundle(directory);
      const sentinel = "private-artist-name-that-must-not-escape";
      mutateArtifact(directory, "volume", (artifact) => ({
        ...artifact,
        unknownPrivateField: sentinel,
      }));

      let message = "";
      try {
        loadPrivateAnalyticalBundle(directory, syntheticDatabaseState);
      } catch (error) {
        assert.ok(error instanceof PrivateBundleError);
        message = error.message;
      }
      assert.notEqual(message, "");
      assert.equal(message.includes(sentinel), false);
      assert.equal(message.includes(directory), false);
    });
  });

  it("rejects nested forbidden, unknown, and count-inconsistent private fields", () => {
    withDirectory((directory) => {
      writeSyntheticPrivateBundle(directory);
      const sentinel = "synthetic-forbidden-private-value";
      mutateArtifact(directory, "genre-eras", (artifact) => {
        const data = artifact.data as Record<string, unknown>;
        return {
          ...artifact,
          data: {
            ...data,
            result: { ...(data.result as object), ipAddress: sentinel },
          },
        };
      });
      assertSanitizedPrivateError(
        () => loadPrivateAnalyticalBundle(directory, syntheticDatabaseState),
        sentinel,
      );

      writeSyntheticPrivateBundle(directory);
      mutateArtifact(directory, "artist-eras", (artifact) => {
        const data = artifact.data as Record<string, unknown>;
        const result = data.result as { intervals: readonly Record<string, unknown>[] };
        const first = result.intervals[0];
        assert.ok(first);
        return {
          ...artifact,
          data: {
            ...data,
            result: {
              intervals: [{ ...first, unexpectedPrivateField: true }, ...result.intervals.slice(1)],
            },
          },
        };
      });
      assertPrivateError(
        () => loadPrivateAnalyticalBundle(directory, syntheticDatabaseState),
        "incompatible_private_bundle",
      );

      writeSyntheticPrivateBundle(directory);
      mutateArtifact(directory, "coverage", (artifact) => {
        const data = artifact.data as Record<string, unknown>;
        const canonical = data.canonical as Record<string, unknown>;
        return {
          ...artifact,
          data: {
            ...data,
            canonical: {
              ...canonical,
              unresolved: { eventCount: 4, rate: 0.1 },
            },
          },
        };
      });
      assertPrivateError(
        () => loadPrivateAnalyticalBundle(directory, syntheticDatabaseState),
        "incompatible_private_bundle",
      );

      writeSyntheticPrivateBundle(directory);
      mutateArtifact(directory, "coverage", (artifact) => ({
        ...artifact,
        data: {
          ...(artifact.data as object),
          generatedAt: "1970-01-01T00:00:00.000Z",
        },
      }));
      assertPrivateError(
        () => loadPrivateAnalyticalBundle(directory, syntheticDatabaseState),
        "incompatible_private_bundle",
      );
    });
  });
});

function addSyntheticCanonicalEvent(connection: SqliteConnection): void {
  const timestamp = Date.parse("2020-01-15T12:00:00.000Z");
  connection
    .prepare(
      "INSERT INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', ?, 'running', 'synthetic-v1')",
    )
    .run([timestamp]);
  connection
    .prepare(
      "INSERT INTO music_entity (id, entity_type, created_at_epoch_ms) VALUES (1, 'artist', ?), (2, 'track', ?)",
    )
    .run([timestamp, timestamp]);
  connection
    .prepare("INSERT INTO artist (id, preferred_name) VALUES (1, 'Synthetic Artist')")
    .run();
  connection
    .prepare("INSERT INTO track (id, artist_id, preferred_title) VALUES (2, 1, 'Synthetic Track')")
    .run();
  connection
    .prepare(
      "INSERT INTO listening_event (id, track_id, started_at_epoch_ms, ended_at_epoch_ms, time_basis, event_status, reconciliation_rule_version) VALUES (1, 2, ?, ?, 'observed_start', 'current', 'synthetic-v1')",
    )
    .run([timestamp, timestamp]);
  connection
    .prepare(
      "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (1, 'lastfm', 1, ?)",
    )
    .run([timestamp]);
  connection
    .prepare(
      "INSERT INTO lastfm_scrobble_source (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name, source_fingerprint_sha256) VALUES (1, 'export', ?, 'Synthetic Artist', 'Synthetic Track', '0000000000000000000000000000000000000000000000000000000000000001')",
    )
    .run([timestamp]);
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
}

function mutateArtifact(
  directory: string,
  artifactName: string,
  change: (artifact: Record<string, unknown>) => Record<string, unknown>,
): void {
  const artifactPath = path.join(directory, `${artifactName}.json`);
  const changedBytes = serialize(
    change(JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>),
  );
  writeFileSync(artifactPath, changedBytes, "utf8");
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    artifacts: Record<string, { file: string; sha256: string }>;
  };
  const descriptor = manifest.artifacts[artifactName];
  assert.ok(descriptor);
  descriptor.sha256 = createHash("sha256").update(changedBytes).digest("hex");
  writeFileSync(manifestPath, serialize(manifest), "utf8");
}

function assertPrivateError(operation: () => unknown, code: PrivateBundleError["code"]): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof PrivateBundleError && error.code === code,
  );
}

function assertSanitizedPrivateError(operation: () => unknown, sentinel: string): void {
  let message = "";
  assert.throws(operation, (error: unknown) => {
    if (!(error instanceof PrivateBundleError)) return false;
    message = error.message;
    return error.code === "incompatible_private_bundle";
  });
  assert.equal(message.includes(sentinel), false);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortJson(object[key])]),
    );
  }
  return value;
}
