import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  loadPrivateAnalyticalBundle,
  PrivateBundleError,
} from "../../../src/publication/private-bundle.ts";
import { syntheticDatabaseState, writeSyntheticPrivateBundle } from "../../fixtures/publication.ts";

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "musicology-p6-04-bundle-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("P6-04 private analytical bundle adapter", () => {
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
    });
  });
});

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
