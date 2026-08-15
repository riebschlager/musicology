import { describe, expect, it } from "vitest";

import { loadSiteSnapshot, type PublicArtistData } from "../src/adapters/public-snapshot.ts";
import {
  buildArtistDetailModel,
  buildArtistEraModel,
  parseArtistDetailState,
  parseArtistEraState,
} from "../src/view-models/artist-eras.ts";

describe("artist-era public view models", () => {
  it("reproduces the public fixture interval boundaries, peak, and components exactly", () => {
    const data = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() }).artists.data;
    const state = parseArtistEraState(
      new URLSearchParams("artist=synthetic-eligible-artist"),
      data.artists,
    );
    const model = buildArtistEraModel(data, state);

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      artistDisplayName: "Synthetic Eligible Artist",
      endPeriodExclusive: "2020-05",
      peak: { period: "2020-01" },
      playCount: 24,
      share: 0.6,
      startPeriod: "2020-01",
      strength: 0.75,
    });
    expect(model.evidenceRows.map((row) => row.period)).toEqual([
      "2020-01",
      "2020-02",
      "2020-03",
      "2020-04",
    ]);
    expect(model.evidenceRows[0]?.components).toEqual({
      consecutiveActiveWindows: 4,
      earlierBaselineChange: 20,
      earlierBaselineRollingPlayCount: 4,
      listeningShare: 0.6,
      rank: 1,
      rollingPlayCount: 24,
      strength: 0.75,
      windowPlayCount: 6,
    });
  });

  it("canonicalizes bounded range and repeated eligible artist selection", () => {
    const data = overlappingArtistData();
    const state = parseArtistEraState(
      new URLSearchParams(
        "artist=synthetic-eligible-artist&artist=synthetic-overlap-artist&from=2020-02&to=2020-04&view=table",
      ),
      data.artists,
    );

    expect(state).toMatchObject({
      artistSlugs: ["synthetic-eligible-artist", "synthetic-overlap-artist"],
      from: "2020-02",
      notice: null,
      to: "2020-04",
      view: "table",
    });
    expect(state.canonicalSearch).toBe(
      "?from=2020-02&artist=synthetic-eligible-artist&artist=synthetic-overlap-artist&view=table",
    );
  });

  it("fails closed for unknown artist state without reflecting a private-tail name", () => {
    const data = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() }).artists.data;
    const state = parseArtistEraState(
      new URLSearchParams("artist=private-tail&view=timeline"),
      data.artists,
    );

    expect(state.artistSlugs).toEqual([]);
    expect(state.canonicalSearch).toBe("");
    expect(state.notice).toMatch(/ignored/u);
    expect(JSON.stringify(state)).not.toContain("private-tail");
  });

  it("retains sparse and overlapping admitted intervals with visible qualifications", () => {
    const data = originalArtistData();
    const model = buildArtistEraModel(
      data,
      parseArtistEraState(new URLSearchParams(), data.artists),
    );

    expect(model.rows).toHaveLength(2);
    expect(model.rows.every((row) => row.overlapCount === 1)).toBe(true);
    expect(
      model.rows.find((row) => row.artistSlug === "synthetic-overlap-artist")?.evidence,
    ).toHaveLength(2);
    expect(model.findings.join(" ")).toMatch(/overlap/u);
    expect(model.findings.join(" ")).toMatch(/one or two approved evidence windows/u);
  });

  it("builds eligible artist detail from period aggregates without event-level fields", () => {
    const artist = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() }).artists.data
      .artists[0];
    expect(artist).toBeDefined();
    if (artist === undefined) return;

    const state = parseArtistDetailState(
      new URLSearchParams("from=2020-02&to=2020-04&view=components"),
      artist,
    );
    const model = buildArtistDetailModel(artist, state);

    expect(state.canonicalSearch).toBe("?from=2020-02&view=components");
    expect(model.evidenceRows.map((row) => row.period)).toEqual([
      "2020-01",
      "2020-02",
      "2020-03",
      "2020-04",
    ]);
    expect(
      model.evidenceRows.reduce((total, row) => total + row.components.windowPlayCount, 0),
    ).toBe(model.intervalRows[0]?.playCount);
    expect(
      model.evidenceRows.some((row) => row.period === model.intervalRows[0]?.peak.period),
    ).toBe(true);
    expect(JSON.stringify(model)).not.toMatch(/"events"|"timestamp"|"trackDisplayName"/u);
  });

  it("keeps the reviewed empty fixture empty without inventing ranges", () => {
    const data = loadSiteSnapshot({ fixture: "empty", projectRoot: process.cwd() }).artists.data;
    const state = parseArtistEraState(new URLSearchParams(), data.artists);
    const model = buildArtistEraModel(data, state);

    expect(state).toMatchObject({ from: null, to: null, canonicalSearch: "" });
    expect(model.rows).toEqual([]);
    expect(model.findings.join(" ")).toMatch(/No eligible public interval/u);
  });
});

function originalArtistData(): PublicArtistData {
  return loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() }).artists.data;
}

function overlappingArtistData(): PublicArtistData {
  const original = originalArtistData();
  const first = original.artists[0];
  expect(first).toBeDefined();
  if (first === undefined) throw new Error("Synthetic full fixture requires an artist");
  const components = {
    ...first.intervals[0]?.peak.components,
    consecutiveActiveWindows: 2,
    earlierBaselineChange: null,
    earlierBaselineRollingPlayCount: null,
    listeningShare: 0.3,
    rank: 2,
    rollingPlayCount: 24,
    strength: 0.8,
    windowPlayCount: 12,
  };
  return {
    ...original,
    artists: [
      first,
      {
        displayName: "Synthetic Overlap Artist",
        intervals: [
          {
            endPeriodExclusive: "2020-05",
            evidence: [
              { components, period: "2020-03" },
              { components, period: "2020-04" },
            ],
            peak: { components, period: "2020-03" },
            playCount: 24,
            share: 0.3,
            startPeriod: "2020-03",
            strength: 0.8,
          },
        ],
        slug: "synthetic-overlap-artist",
      },
    ],
  };
}
