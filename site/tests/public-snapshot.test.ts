import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateApprovedPublicSnapshot,
  approvePublicCandidate,
  readStoredPublicSnapshot,
} from "../../src/publication/workflow.ts";
import { loadSiteSnapshot, type SiteSnapshotError } from "../src/adapters/public-snapshot.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("build-only public snapshot adapter", () => {
  it("loads and validates only the deterministic public fixture artifacts", () => {
    const snapshot = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() });

    expect(snapshot.manifest.snapshotId).toBe("snapshot-2026-08-09-fixture");
    expect(snapshot.history.data.totalPlayCount).toBe(50);
    expect(snapshot.artists.data.artists.map((artist) => artist.slug)).toEqual([
      "synthetic-eligible-artist",
      "synthetic-overlap-artist",
    ]);
    expect(
      snapshot.artists.data.artists.every((artist) =>
        artist.intervals.some((interval) => interval.playCount >= 24 && interval.strength >= 0.75),
      ),
    ).toBe(true);
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

  it("loads a retained approved snapshot from committed-style files without private inputs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "musicology-site-approved-"));
    temporaryDirectories.push(root);
    const publicationDirectory = path.join(root, "public-release");
    const fixtureDirectory = path.join(
      process.cwd(),
      "tests",
      "fixtures",
      "public-snapshots",
      "full",
    );
    const approvedDirectory = approvePublicCandidate(
      fixtureDirectory,
      publicationDirectory,
      "2026-08-15",
      readStoredPublicSnapshot(fixtureDirectory).manifest.reportSha256,
    );
    activateApprovedPublicSnapshot(publicationDirectory, "snapshot-2026-08-09-fixture");
    vi.stubEnv("MUSICOLOGY_PUBLICATION_DIR", publicationDirectory);

    const snapshot = loadSiteSnapshot({ projectRoot: root });
    expect(snapshot.manifest.state).toBe("approved");
    expect(snapshot.history.data.totalPlayCount).toBe(50);
    expect(readdirSync(root, { recursive: true }).map(String)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.(?:db|sqlite|sqlite3)$/u)]),
    );
    expect(approvedDirectory).toContain("public-release/approved/");
  });
});
