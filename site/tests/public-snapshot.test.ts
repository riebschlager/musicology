import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type SiteSnapshotError, loadSiteSnapshot } from "../src/adapters/public-snapshot.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("build-only public snapshot adapter", () => {
  it("loads and validates only the deterministic public fixture artifacts", () => {
    const snapshot = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() });

    expect(snapshot.manifest.snapshotId).toBe("snapshot-2026-08-09-fixture");
    expect(snapshot.history.data.totalPlayCount).toBe(30);
    expect(snapshot.artists.data.artists.map((artist) => artist.slug)).toEqual([
      "synthetic-eligible-artist",
    ]);
    expect(snapshot.stories.data.stories).toHaveLength(2);
    expect(Object.keys(snapshot).sort()).toEqual([
      "artists",
      "editorial",
      "history",
      "manifest",
      "stories",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("review-report");
  });

  it("represents the reviewed empty fixture without invented history", () => {
    const snapshot = loadSiteSnapshot({ fixture: "empty", projectRoot: process.cwd() });

    expect(snapshot.manifest.coverage.dateRange).toBeNull();
    expect(snapshot.history.data.periods).toEqual([]);
    expect(snapshot.artists.data.artists).toEqual([]);
    expect(snapshot.stories.data.stories).toEqual([]);
  });

  it("rejects unsupported fixture selectors before reading a path", () => {
    expect(() =>
      loadSiteSnapshot({ fixture: "../../data/inputs", projectRoot: process.cwd() }),
    ).toThrowError(
      expect.objectContaining<Partial<SiteSnapshotError>>({ code: "invalid_fixture" }),
    );
  });

  it("fails closed when an active approved snapshot is unavailable", () => {
    const root = mkdtempSync(path.join(tmpdir(), "musicology-site-adapter-"));
    temporaryDirectories.push(root);

    expect(() => loadSiteSnapshot({ projectRoot: root })).toThrowError(
      expect.objectContaining<Partial<SiteSnapshotError>>({ code: "snapshot_missing" }),
    );
  });
});
