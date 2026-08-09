import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  loadPrivateAnalyticalBundle,
  type LoadedPrivateAnalyticalBundle,
} from "../../../src/publication/private-bundle.ts";
import {
  PublicationProjectionError,
  projectPublicSnapshot,
  rediscoverySelectionKey,
  type PublicationProjectionInput,
} from "../../../src/publication/projection.ts";
import {
  emptyPublicationInput,
  syntheticDatabaseState,
  syntheticPublicationInput,
  writeSyntheticPrivateBundle,
} from "../../fixtures/publication.ts";

function withBundle(options: { readonly empty?: boolean }, run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "musicology-p6-04-projection-"));
  try {
    writeSyntheticPrivateBundle(directory, options);
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("P6-04 private-to-public projection", () => {
  it("projects every required artifact with reduced dates and exact threshold boundaries", () => {
    withBundle({}, (directory) => {
      const bundle = loadPrivateAnalyticalBundle(directory, syntheticDatabaseState);
      const projected = projectPublicSnapshot(bundle, syntheticPublicationInput());
      assert.deepEqual(Object.keys(projected.artifacts).sort(), [
        "artists",
        "editorial",
        "history",
        "stories",
      ]);
      assert.deepEqual(projected.coverage.dateRange, {
        endPeriodExclusive: "2021-01",
        startPeriod: "2020-01",
      });
      assert.equal(projected.asOfDate, "2021-01-01");

      const history = projected.artifacts.history.data as {
        periods: readonly { period: string }[];
        totalPlayCount: number;
      };
      assert.equal(history.periods[0]?.period, "2020-01");
      assert.equal(history.periods.at(-1)?.period, "2020-12");
      assert.equal(history.totalPlayCount, 30);

      const artists = projected.artifacts.artists.data as {
        artists: readonly {
          displayName: string;
          intervals: readonly {
            evidence: readonly { components: { windowPlayCount: number } }[];
            playCount: number;
            strength: number;
          }[];
          slug: string;
        }[];
      };
      assert.equal(artists.artists.length, 1);
      const eligible = artists.artists[0];
      assert.ok(eligible);
      assert.equal(eligible.displayName, "Synthetic Eligible Artist");
      assert.equal(eligible.slug, "synthetic-eligible-artist");
      assert.equal(eligible.intervals.length, 1);
      const qualifyingInterval = eligible.intervals[0];
      assert.ok(qualifyingInterval);
      assert.equal(qualifyingInterval.playCount, 24);
      assert.equal(qualifyingInterval.strength, 0.75);
      assert.equal(
        qualifyingInterval.evidence.reduce((sum, row) => sum + row.components.windowPlayCount, 0),
        24,
      );
    });
  });

  it("bounds a long artist interval around its analytical peak and recomputes its aggregate", () => {
    withBundle({}, (directory) => {
      const bundle = structuredClone(
        loadPrivateAnalyticalBundle(directory, syntheticDatabaseState),
      ) as LoadedPrivateAnalyticalBundle;
      const interval = bundle.artistEras.result.intervals[0];
      assert.ok(interval);
      const evidence = Array.from({ length: 49 }, (_, index) => {
        const windowStart = syntheticMonth(index);
        return {
          components: {
            ...interval.peak.components,
            strength: index === 48 ? 0.9 : 0.75,
            windowPlayCount: 1,
          },
          windowEndExclusive: syntheticMonth(index + 1),
          windowStart,
        };
      });
      const peak = evidence.at(-1);
      assert.ok(peak);
      (bundle.artistEras.result.intervals as unknown as Record<string, unknown>[])[0] = {
        ...interval,
        evidence,
        peak: { components: peak.components, windowStart: peak.windowStart },
        playCount: 49,
        share: 0.8,
        strength: 0.9,
        windowEndExclusive: peak.windowEndExclusive,
        windowStart: evidence[0]?.windowStart,
      };

      const projected = projectPublicSnapshot(bundle, syntheticPublicationInput());
      const artists = projected.artifacts.artists.data as {
        artists: { intervals: { evidence: unknown[]; playCount: number; strength: number }[] }[];
      };
      const bounded = artists.artists[0]?.intervals[0];
      assert.ok(bounded);
      assert.equal(bounded.evidence.length, 48);
      assert.equal(bounded.playCount, 48);
      assert.equal(bounded.strength, 0.9);
    });
  });

  it("admits wholly manual track identity without a track candidate or track-level evidence", () => {
    withBundle({}, (directory) => {
      const bundle = loadPrivateAnalyticalBundle(directory, syntheticDatabaseState);
      assert.equal(
        JSON.stringify(bundle).includes("Wholly Manual Selected Track"),
        false,
        "manual identity must not originate in the private bundle",
      );
      const projected = projectPublicSnapshot(bundle, syntheticPublicationInput());
      const stories = (projected.artifacts.stories.data as { stories: Record<string, unknown>[] })
        .stories;
      const rediscovery = stories.find((story) => story.slug === "synthetic-rediscovery");
      assert.ok(rediscovery);
      assert.deepEqual(rediscovery.selectedTrack, {
        artistDisplayName: "Wholly Manual Track Artist",
        slug: "wholly-manual-selected-track",
        storySlug: "synthetic-rediscovery",
        trackDisplayName: "Wholly Manual Selected Track",
      });
      assert.equal((rediscovery.parameters as Record<string, unknown>).scope, "artist");
      assert.equal(JSON.stringify(rediscovery.evidence).includes("track"), false);
    });
  });

  it("rejects track-scoped analytical evidence and mismatched public artist references", () => {
    withBundle({}, (directory) => {
      const loaded = loadPrivateAnalyticalBundle(directory, syntheticDatabaseState);

      const trackScoped = structuredClone(loaded) as LoadedPrivateAnalyticalBundle;
      const trackRecord = trackScoped.rediscovery.result.rediscoveries[0];
      assert.ok(trackRecord);
      (trackRecord as { scope: "artist" | "track" }).scope = "track";
      (trackScoped.rediscovery.parameters as { scope: "artist" | "track" }).scope = "track";
      const trackBase = syntheticPublicationInput();
      const trackInput: PublicationProjectionInput = {
        ...trackBase,
        stories: trackBase.stories.map((story, index) =>
          index === 0 ? { ...story, selectionKey: rediscoverySelectionKey(trackRecord) } : story,
        ),
      };
      assertProjectionError(() => projectPublicSnapshot(trackScoped, trackInput));

      const mismatchedRediscovery = structuredClone(loaded) as LoadedPrivateAnalyticalBundle;
      const rediscoveryRecord = mismatchedRediscovery.rediscovery.result.rediscoveries[0];
      assert.ok(rediscoveryRecord);
      (rediscoveryRecord as { entityId: number }).entityId = 2;
      const rediscoveryBase = syntheticPublicationInput();
      const rediscoveryInput: PublicationProjectionInput = {
        ...rediscoveryBase,
        stories: rediscoveryBase.stories.map((story, index) =>
          index === 0
            ? { ...story, selectionKey: rediscoverySelectionKey(rediscoveryRecord) }
            : story,
        ),
      };
      assertProjectionError(() => projectPublicSnapshot(mismatchedRediscovery, rediscoveryInput));

      const dormancyBase = syntheticPublicationInput();
      const dormancyInput: PublicationProjectionInput = {
        ...dormancyBase,
        stories: dormancyBase.stories.map((story, index) =>
          index === 1 ? { ...story, artistSlug: "synthetic-eligible-artist" } : story,
        ),
      };
      assertProjectionError(() => projectPublicSnapshot(loaded, dormancyInput));
    });
  });

  it("publishes no private-only fields or private selection keys", () => {
    withBundle({}, (directory) => {
      const projected = projectPublicSnapshot(
        loadPrivateAnalyticalBundle(directory, syntheticDatabaseState),
        syntheticPublicationInput(),
      );
      const serialized = JSON.stringify(projected);
      for (const forbidden of [
        "artistId",
        "databaseState",
        "entityId",
        "inputFiles",
        "selectionKey",
        "sourcePath",
        "timestamp",
      ]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
    });
  });

  it("represents empty history without invented dates, rows, artists, or stories", () => {
    withBundle({ empty: true }, (directory) => {
      const projected = projectPublicSnapshot(
        loadPrivateAnalyticalBundle(directory, syntheticDatabaseState),
        emptyPublicationInput(),
      );
      assert.equal(projected.asOfDate, null);
      assert.equal(projected.coverage.dateRange, null);
      assert.equal(projected.coverage.canonicalEventCount, 0);
      assert.deepEqual((projected.artifacts.history.data as { periods: unknown[] }).periods, []);
      assert.deepEqual((projected.artifacts.artists.data as { artists: unknown[] }).artists, []);
      assert.deepEqual((projected.artifacts.stories.data as { stories: unknown[] }).stories, []);
    });
  });

  it("rejects duplicate, missing-story, and unreviewed-name manual track inputs", () => {
    withBundle({}, (directory) => {
      const bundle = loadPrivateAnalyticalBundle(directory, syntheticDatabaseState);
      const base = syntheticPublicationInput();
      const selectedTrack = base.selectedTracks[0];
      assert.ok(selectedTrack);
      const duplicate: PublicationProjectionInput = {
        ...base,
        selectedTracks: [
          ...base.selectedTracks,
          {
            ...selectedTrack,
            storySlug: "synthetic-dormancy",
            trackSlug: "duplicate-track",
          },
        ],
      };
      assertProjectionError(() => projectPublicSnapshot(bundle, duplicate));

      const missingStory: PublicationProjectionInput = {
        ...base,
        selectedTracks: base.selectedTracks.map((track) => ({
          ...track,
          storySlug: "missing-story",
        })),
      };
      assertProjectionError(() => projectPublicSnapshot(bundle, missingStory));

      const unreviewed = structuredClone(base) as unknown as Record<string, unknown>;
      const stories = unreviewed.stories as Record<string, unknown>[];
      const first = stories[0];
      assert.ok(first);
      first.selectedTrack = { trackDisplayName: "Unreviewed Track Name" };
      assertProjectionError(() =>
        projectPublicSnapshot(bundle, unreviewed as unknown as PublicationProjectionInput),
      );
    });
  });
});

function assertProjectionError(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => error instanceof PublicationProjectionError);
}

function syntheticMonth(index: number): string {
  const year = 2016 + Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}
