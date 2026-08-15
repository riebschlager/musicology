// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSiteSnapshot } from "../src/adapters/public-snapshot.ts";
import { LongViewExplorer } from "../src/islands/LongViewExplorer.tsx";

vi.mock("../src/charts/long-view-plot.ts", () => ({
  createLongViewPlot: () => document.createElementNS("http://www.w3.org/2000/svg", "svg"),
}));

const snapshot = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() });

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  document.head.innerHTML = "";
});

describe("long-view explorer", () => {
  it("server-renders totals, findings, tables, and the metric boundary", () => {
    renderExplorer();

    expect(screen.getByText(/30 canonical plays fall within/u)).toBeTruthy();
    expect(screen.getByRole("table", { name: /Canonical plays and source context/u })).toBeTruthy();
    expect(screen.getByRole("table", { name: /Full-calendar-year source coverage/u })).toBeTruthy();
    expect(screen.getByText("Spotify-only duration")).toBeTruthy();
    expect(screen.getByText(/No listened-time or thresholded series is published/u)).toBeTruthy();
    expect(screen.getByText(/Public downloads are not authorized/u)).toBeTruthy();
    const totalRow = screen.getByRole("table", { name: /Canonical plays/u }).querySelector("tfoot");
    expect(totalRow).not.toBeNull();
    if (totalRow === null) throw new Error("Canonical play table requires a total row");
    expect(within(totalRow).getByText("30")).toBeTruthy();
    expect(document.querySelector(".filter-panel__summary")?.textContent).toContain(
      "Showing year canonical play counts",
    );
  });

  it("hydrates a bounded direct link and preserves a canonical reproducible state", async () => {
    document.head.innerHTML = '<link rel="canonical" href="https://music.the816.com/history/">';
    window.history.replaceState(
      {},
      "",
      "/history/?from=2020-04&to=2020-09&grain=quarter&view=table",
    );
    renderExplorer();

    await waitFor(() =>
      expect(document.querySelector(".filter-panel__summary")?.textContent).toContain(
        "Showing quarter canonical play counts from Apr 2020–Sep 2020",
      ),
    );
    expect((screen.getByLabelText("Reading mode") as HTMLSelectElement).value).toBe("table");
    expect(
      screen.getByRole("link", { name: /https:\/\/music\.the816\.com/u }).getAttribute("href"),
    ).toBe("/history/?from=2020-04&to=2020-09&grain=quarter&view=table");
    expect(document.querySelector("link[rel='canonical']")?.getAttribute("href")).toBe(
      "https://music.the816.com/history/?from=2020-04&to=2020-09&grain=quarter&view=table",
    );
    expect(
      within(screen.getByRole("table", { name: /Canonical plays/u })).getByText("15"),
    ).toBeTruthy();
    expect(screen.getByText(/full-calendar-year source-evidence aggregates/u).textContent).toMatch(
      /include approved evidence from outside the selected months/u,
    );
  });

  it("updates only within approved bounds and rejects unsafe URL values visibly", async () => {
    window.history.replaceState({}, "", "/history/?from=1999-01&artist=private-tail");
    const result = renderExplorer();

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/ignored/u));
    expect(result.container.textContent).not.toContain("private-tail");

    fireEvent.change(screen.getByLabelText("From month"), { target: { value: "2020-04" } });
    fireEvent.change(screen.getByLabelText("Through month"), { target: { value: "2020-09" } });
    fireEvent.change(screen.getByLabelText("Time grain"), { target: { value: "quarter" } });
    expect(
      screen.getByRole("link", { name: /https:\/\/music\.the816\.com/u }).getAttribute("href"),
    ).toBe("/history/?from=2020-04&to=2020-09&grain=quarter");
  });
});

function renderExplorer() {
  return render(
    <LongViewExplorer
      allowRange={true}
      asOfDate={snapshot.manifest.asOfDate}
      canonicalEventCount={snapshot.manifest.coverage.canonicalEventCount}
      history={snapshot.history.data}
      route="/history/"
      spotifyDurationEventCount={snapshot.manifest.coverage.spotifyDurationEventCount}
    />,
  );
}
