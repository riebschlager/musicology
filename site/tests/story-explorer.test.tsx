// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { loadSiteSnapshot, type PublicRediscoveryStory } from "../src/adapters/public-snapshot.ts";
import { StoryEvidenceCard } from "../src/components/StoryEvidence.tsx";
import { StoryExplorer } from "../src/islands/StoryExplorer.tsx";
import { buildStoryViewModel } from "../src/view-models/stories.ts";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  document.head.innerHTML = "";
});

describe("curated story progressive enhancement", () => {
  it("server-renders selected stories, qualifications, evidence, and reviewed detail links", () => {
    const snapshot = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() });
    render(<StoryExplorer asOfDate={snapshot.manifest.asOfDate} data={snapshot.stories.data} />);

    expect(screen.getByRole("heading", { name: "Title for synthetic-rediscovery" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Title for synthetic-dormancy" })).toBeTruthy();
    expect(screen.getAllByText("Sustained rediscovery").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Likely dormant as of 2021-01-01").length).toBeGreaterThan(0);
    expect(screen.getByText(/source gap can resemble an absence/u)).toBeTruthy();
    expect(screen.getByText(/right-censored and never permanent/u)).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: "Read the reviewed story and evidence" })[0]
        ?.getAttribute("href"),
    ).toBe("/stories/synthetic-rediscovery/");

    const rediscoveryCard = screen
      .getByRole("heading", { name: "Title for synthetic-rediscovery" })
      .closest("article");
    expect(rediscoveryCard).not.toBeNull();
    if (rediscoveryCard === null) return;
    fireEvent.click(within(rediscoveryCard).getByText(/Inspect every approved/u));
    expect(within(rediscoveryCard).getByRole("table", { name: "Approved evidence" })).toBeTruthy();
    expect(
      within(rediscoveryCard).getByRole("table", {
        name: "Published classification parameters",
      }),
    ).toBeTruthy();
    expect(
      within(rediscoveryCard).getByText(
        /Wholly Manual Track Artist.*Wholly Manual Selected Track/u,
      ),
    ).toBeTruthy();
  });

  it("hydrates bounded URL state and rejects unknown state without reflecting it", async () => {
    const snapshot = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() });
    document.head.innerHTML = '<link rel="canonical" href="https://music.the816.com/stories/">';
    window.history.replaceState({}, "", "/stories/?kind=private-tail&artist=private-tail");
    const result = render(
      <StoryExplorer asOfDate={snapshot.manifest.asOfDate} data={snapshot.stories.data} />,
    );

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/ignored/u));
    expect(result.container.textContent).not.toContain("private-tail");
    expect(document.querySelector("link[rel='canonical']")?.getAttribute("href")).toBe(
      "https://music.the816.com/stories/",
    );
  });

  it("builds shareable kind and list state only over the reviewed story set", () => {
    const snapshot = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() });
    render(<StoryExplorer asOfDate={snapshot.manifest.asOfDate} data={snapshot.stories.data} />);

    fireEvent.change(screen.getByLabelText("Story kind"), { target: { value: "dormancy" } });
    fireEvent.change(screen.getByLabelText("Reading mode"), { target: { value: "list" } });

    expect(
      screen.getByRole("link", { name: /music\.the816\.com\/stories/u }).getAttribute("href"),
    ).toBe("/stories/?kind=dormancy&view=list");
    expect(screen.getByRole("heading", { name: "Title for synthetic-dormancy" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Title for synthetic-rediscovery" })).toBeNull();
  });

  it("renders supersession in both directions with links to both approved records", () => {
    const snapshot = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() });
    const dormancy = snapshot.stories.data.stories.find((story) => story.kind === "dormancy");
    const rediscovery = snapshot.stories.data.stories.find((story) => story.kind === "rediscovery");
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

    const result = render(
      <>
        <StoryEvidenceCard story={olderModel} />
        <StoryEvidenceCard story={laterModel} />
      </>,
    );

    expect(result.container.textContent).toMatch(/Superseded by the later approved return story/u);
    expect(result.container.textContent).toMatch(/supersedes the earlier dormancy observation/u);
    expect(
      screen.getAllByRole("link", { name: "A later approved return" })[0]?.getAttribute("href"),
    ).toBe("/stories/later-approved-return/");
    expect(
      screen.getByRole("link", { name: "Title for synthetic-dormancy" }).getAttribute("href"),
    ).toBe("/stories/synthetic-dormancy/");
  });
});
