import { describe, expect, it } from "vitest";

import {
  loadSiteSnapshot,
  type PublicRediscoveryStory,
  type PublicStoryData,
} from "../src/adapters/public-snapshot.ts";
import {
  buildStoryExplorerModel,
  buildStoryViewModel,
  parseStoryExplorerState,
} from "../src/view-models/stories.ts";

describe("curated story public view models", () => {
  it("exposes every approved rediscovery and dormancy evidence value with honest wording", () => {
    const data = storyData();
    const model = buildStoryExplorerModel(
      data,
      parseStoryExplorerState(new URLSearchParams(), data.stories),
      "2021-01-01",
    );

    expect(model.stories).toHaveLength(2);
    const rediscovery = model.stories.find((story) => story.kind === "rediscovery");
    const dormancy = model.stories.find((story) => story.kind === "dormancy");
    expect(rediscovery).toMatchObject({
      classificationLabel: "Sustained rediscovery",
      evidenceScopeLabel: "Artist-level return evidence",
      period: "2020-03",
      selectedTrackLabel: "Wholly Manual Track Artist — Wholly Manual Selected Track",
    });
    expect(rediscovery?.evidenceRows).toEqual(
      expect.arrayContaining([
        { label: "Prior listen (reduced date)", value: "Jan 2019" },
        { label: "Observed absence gap", value: "425 days" },
        { label: "Return intensity", value: "5 plays in 30 days" },
        {
          label: "Persistence",
          value: "Persistent in the published window · 4 plays in 90 days",
        },
        { label: "Related era", value: "Jan 2020–Apr 2020" },
      ]),
    );
    expect(rediscovery?.parameterRows).toHaveLength(7);
    expect(rediscovery?.warnings.join(" ")).toMatch(/source gap can resemble an absence/u);
    expect(rediscovery?.warnings.join(" ")).toMatch(/wholly manual reviewed editorial detail/u);

    expect(dormancy?.classificationLabel).toBe("Likely dormant as of 2021-01-01");
    expect(dormancy?.evidenceRows).toEqual(
      expect.arrayContaining([
        { label: "Last listen (reduced date)", value: "Jun 2018" },
        { label: "Observed after last listen", value: "915.3 days" },
        { label: "Overall confidence", value: "86.7%" },
        { label: "Historical-importance confidence", value: "80%" },
        { label: "Former-cadence confidence", value: "80%" },
        { label: "Observation-completeness confidence", value: "100%" },
      ]),
    );
    expect(dormancy?.parameterRows).toHaveLength(7);
    expect(dormancy?.warnings.join(" ")).toMatch(/right-censored and never permanent/u);
    expect(JSON.stringify(model)).not.toContain("likely_abandoned_as_of");
  });

  it("canonicalizes bounded kind, month, and reading-mode state", () => {
    const data = storyData();
    const state = parseStoryExplorerState(
      new URLSearchParams("kind=dormancy&from=2018-06&to=2018-06&view=list"),
      data.stories,
    );
    const model = buildStoryExplorerModel(data, state, "2021-01-01");

    expect(state).toMatchObject({
      canonicalSearch: "?kind=dormancy&to=2018-06&view=list",
      from: "2018-06",
      kind: "dormancy",
      notice: null,
      to: "2018-06",
      view: "list",
    });
    expect(model.stories.map((story) => story.slug)).toEqual(["synthetic-dormancy"]);
  });

  it("fails closed for unsupported URL state without reflecting a private value", () => {
    const data = storyData();
    const state = parseStoryExplorerState(
      new URLSearchParams("kind=private-tail&artist=private-tail"),
      data.stories,
    );

    expect(state).toMatchObject({ canonicalSearch: "", kind: "all" });
    expect(state.notice).toMatch(/ignored/u);
    expect(JSON.stringify(state)).not.toContain("private-tail");
  });

  it("distinguishes every approved rediscovery class without upgrading the evidence", () => {
    const base = rediscoveryStory();
    const oneOff: PublicRediscoveryStory = {
      ...base,
      evidence: {
        ...base.evidence,
        classification: "one_off_return",
        persistence: "not_persistent",
        persistencePlayCount: 1,
        relatedEra: null,
      },
      order: 2,
      selectedTrack: null,
      slug: "one-off-return",
      title: "One-off return",
    };
    const newEra: PublicRediscoveryStory = {
      ...base,
      evidence: { ...base.evidence, classification: "return_beginning_new_era" },
      order: 3,
      selectedTrack: null,
      slug: "new-era-return",
      title: "New-era return",
    };
    const stories = [base, oneOff, newEra];

    expect(
      stories.map((story) => buildStoryViewModel(story, stories, "2021-01-01").classificationLabel),
    ).toEqual(["Sustained rediscovery", "One-off return", "Return beginning a new era"]);
  });

  it("links a later rediscovery as the visible supersession of an older dormancy conclusion", () => {
    const data = storyData();
    const dormancy = data.stories.find((story) => story.kind === "dormancy");
    const rediscovery = data.stories.find((story) => story.kind === "rediscovery");
    expect(dormancy).toBeDefined();
    expect(rediscovery).toBeDefined();
    if (dormancy === undefined || rediscovery?.kind !== "rediscovery") return;
    const later: PublicRediscoveryStory = {
      ...rediscovery,
      selectedTrack: null,
      slug: "later-approved-return",
      supersedesStorySlug: dormancy.slug,
      title: "A later approved return",
    };
    const older = { ...dormancy, artistSlug: rediscovery.artistSlug };
    const stories = [older, later];
    const olderModel = buildStoryViewModel(older, stories, "2021-01-01");
    const laterModel = buildStoryViewModel(later, stories, "2021-01-01");

    expect(olderModel.supersededByStories).toEqual([
      {
        kindLabel: "Return story",
        slug: "later-approved-return",
        title: "A later approved return",
      },
    ]);
    expect(olderModel.warnings.join(" ")).toMatch(/rather than being silently rewritten/u);
    expect(laterModel.supersedesStory?.slug).toBe("synthetic-dormancy");
    expect(laterModel.warnings.join(" ")).toMatch(/preserving the earlier record/u);
  });

  it("keeps the reviewed empty fixture empty without inventing a period", () => {
    const data = loadSiteSnapshot({ fixture: "empty", projectRoot: process.cwd() }).stories.data;
    const state = parseStoryExplorerState(new URLSearchParams(), data.stories);
    const model = buildStoryExplorerModel(data, state, null);

    expect(state).toMatchObject({ canonicalSearch: "", from: null, to: null });
    expect(model.bounds).toBeNull();
    expect(model.stories).toEqual([]);
    expect(model.findings.join(" ")).toMatch(/never substituted/u);
  });
});

function storyData(): PublicStoryData {
  return loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() }).stories.data;
}

function rediscoveryStory(): PublicRediscoveryStory {
  const story = storyData().stories.find((candidate) => candidate.kind === "rediscovery");
  expect(story).toBeDefined();
  if (story?.kind !== "rediscovery") throw new Error("Synthetic fixture needs a rediscovery story");
  return story;
}
