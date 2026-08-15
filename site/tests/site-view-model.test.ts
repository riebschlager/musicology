import { describe, expect, it } from "vitest";

import { loadSiteSnapshot } from "../src/adapters/public-snapshot.ts";
import {
  buildAnalyticalDisclosure,
  buildExplorerState,
  buildStoryCards,
  formatMonth,
  formatMonthRange,
  parseExplorerState,
} from "../src/view-models/site.ts";

describe("site view models", () => {
  it("omits default URL state and preserves only allowlisted non-default values", () => {
    expect(parseExplorerState(new URLSearchParams())).toEqual({
      canonicalSearch: "",
      grain: "month",
      notice: null,
      view: "chart",
    });

    expect(parseExplorerState(new URLSearchParams("grain=year&view=table"))).toEqual({
      canonicalSearch: "?grain=year&view=table",
      grain: "year",
      notice: null,
      view: "table",
    });
  });

  it("falls back visibly for invalid or unsupported URL state", () => {
    const state = parseExplorerState(new URLSearchParams("grain=day&view=map&artist=private-tail"));

    expect(state.grain).toBe("month");
    expect(state.view).toBe("chart");
    expect(state.canonicalSearch).toBe("");
    expect(state.notice).toMatch(/ignored/u);
    expect(JSON.stringify(state)).not.toContain("private-tail");
  });

  it("rebuilds canonical URL state whenever a filter changes", () => {
    expect(buildExplorerState("year", "chart").canonicalSearch).toBe("?grain=year");
    expect(buildExplorerState("year", "table").canonicalSearch).toBe("?grain=year&view=table");
    expect(buildExplorerState("month", "chart").canonicalSearch).toBe("");
  });

  it("maps exactly the reviewed story entries without inventing another kind or count", () => {
    const snapshot = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() });
    const oneStory = snapshot.stories.data.stories.slice(0, 1);

    expect(buildStoryCards(oneStory)).toEqual([
      {
        kind: "rediscovery",
        slug: "synthetic-rediscovery",
        summary: "Summary for synthetic-rediscovery.",
        title: "Title for synthetic-rediscovery",
        trackLabel: "Wholly Manual Track Artist — Wholly Manual Selected Track",
      },
    ]);
    expect(buildStoryCards([])).toEqual([]);
  });

  it("builds one complete disclosure envelope from approved public fields", () => {
    const disclosure = buildAnalyticalDisclosure(
      loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() }),
    );

    expect(disclosure.metricDefinition).toMatch(/canonical track event/u);
    expect(disclosure.durationScope).toMatch(/Spotify-backed duration/u);
    expect(disclosure.sourceGapSummary).toMatch(/not proof that listening stopped/u);
    expect(disclosure.unresolvedSummary).toContain("10%");
    expect(disclosure.genreStatus).toMatch(/not included/u);
    expect(disclosure.parameters).toHaveLength(3);
    expect(disclosure.timezone).toBe("America/Chicago");
    expect(disclosure.asOfLabel).toBe("2021-01-01");
    expect(disclosure.publicationLabel).toMatch(/not a published snapshot/u);
    expect(disclosure.versionSummary).toMatch(/listening-volume-v1/u);
  });

  it("keeps empty-snapshot duration and gap wording honest", () => {
    const disclosure = buildAnalyticalDisclosure(
      loadSiteSnapshot({ fixture: "empty", projectRoot: process.cwd() }),
    );

    expect(disclosure.durationScope).toMatch(/No Spotify-backed duration/u);
    expect(disclosure.sourceGapSummary).toMatch(/No source gap is listed/u);
    expect(disclosure.asOfLabel).toMatch(/No analytical/u);
  });

  it("formats reduced months without using the machine timezone", () => {
    expect(formatMonth("2020-01")).toBe("Jan 2020");
    expect(formatMonthRange("2020-01", "2021-01")).toBe("Jan 2020–Dec 2020");
    expect(formatMonthRange("2019-12", "2020-01")).toBe("Dec 2019–Dec 2019");
  });
});
