// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { loadSiteSnapshot } from "../src/adapters/public-snapshot.ts";
import { ArtistDetailExplorer } from "../src/islands/ArtistDetailExplorer.tsx";
import { ArtistEraExplorer } from "../src/islands/ArtistEraExplorer.tsx";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  document.head.innerHTML = "";
});

describe("artist-era progressive enhancement", () => {
  it("server-renders the public fixture timeline, interval table, and exact component table", () => {
    const data = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() }).artists.data;
    render(<ArtistEraExplorer data={data} />);

    expect(screen.getByRole("img", { name: /2 eligible artist-era intervals/u })).toBeTruthy();
    expect(screen.getAllByText("Synthetic Eligible Artist").length).toBeGreaterThan(1);
    expect(
      screen.getByRole("table", { name: /Eligible aggregate artist intervals/u }),
    ).toBeTruthy();
    expect(screen.getByRole("table", { name: /Component evidence/u })).toBeTruthy();
    expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("link", { name: "Open aggregate artist detail" })[0]
        ?.getAttribute("href"),
    ).toBe("/artists/synthetic-eligible-artist/");
  });

  it("hydrates a bounded direct link and rejects an unknown artist without reflecting it", async () => {
    const data = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() }).artists.data;
    document.head.innerHTML = '<link rel="canonical" href="https://music.the816.com/artists/">';
    window.history.replaceState({}, "", "/artists/?artist=private-tail&view=table");
    const result = render(<ArtistEraExplorer data={data} />);

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/ignored/u));
    expect(result.container.textContent).not.toContain("private-tail");
    expect(document.querySelector("link[rel='canonical']")?.getAttribute("href")).toBe(
      "https://music.the816.com/artists/?view=table",
    );
  });

  it("searches only the already-public cohort and builds repeated artist URL state", () => {
    const data = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() }).artists.data;
    render(<ArtistEraExplorer data={data} />);

    fireEvent.input(screen.getByLabelText("Search eligible artists"), {
      target: { value: "Eligible" },
    });
    fireEvent.click(screen.getByLabelText("Synthetic Eligible Artist"));
    expect(
      screen.getByRole("link", { name: /music\.the816\.com\/artists/u }).getAttribute("href"),
    ).toBe("/artists/?artist=synthetic-eligible-artist");

    fireEvent.input(screen.getByLabelText("Search eligible artists"), {
      target: { value: "Unpublished Name" },
    });
    expect(screen.getByRole("status").textContent).toMatch(/No eligible public artist/u);
  });

  it("renders eligible detail as aggregate summaries and component evidence", async () => {
    const artist = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() }).artists.data
      .artists[0];
    expect(artist).toBeDefined();
    if (artist === undefined) return;
    document.head.innerHTML =
      '<link rel="canonical" href="https://music.the816.com/artists/synthetic-eligible-artist/">';
    window.history.replaceState(
      {},
      "",
      "/artists/synthetic-eligible-artist/?from=2020-02&view=components",
    );
    render(<ArtistDetailExplorer artist={artist} />);

    await waitFor(() =>
      expect((screen.getByLabelText("From month") as HTMLSelectElement).value).toBe("2020-02"),
    );
    expect(screen.getByRole("table", { name: /Public period summaries/u })).toBeTruthy();
    expect(screen.getByRole("table", { name: /Component evidence/u })).toBeTruthy();
    expect(screen.getByText(/not individual listens or an event log/u)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Synthetic Eligible Artist · Jan 2020" })
        .getAttribute("href"),
    ).toBe("/artists/?from=2020-01&to=2020-01&artist=synthetic-eligible-artist&view=table");
    expect(document.querySelector("link[rel='canonical']")?.getAttribute("href")).toBe(
      "https://music.the816.com/artists/synthetic-eligible-artist/?from=2020-02&view=components",
    );
  });
});
