// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { ExplorerFilter } from "../src/islands/ExplorerFilter.tsx";
import { parseExplorerState } from "../src/view-models/site.ts";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  document.head.innerHTML = "";
});

describe("explorer filter enhancement", () => {
  it("server-renders the useful default form before effects run", () => {
    render(<ExplorerFilter defaultState={parseExplorerState(new URLSearchParams())} />);

    expect((screen.getByLabelText("Time grain") as HTMLSelectElement).value).toBe("month");
    expect((screen.getByLabelText("Reading mode") as HTMLSelectElement).value).toBe("chart");
    expect(screen.getByText(/Current state:/u).textContent).toContain("month grain, chart first");
    expect(screen.getByRole("button", { name: "Apply view" }).getAttribute("type")).toBe("submit");
  });

  it("hydrates an allowlisted direct link and updates its canonical metadata", async () => {
    document.head.innerHTML = '<link rel="canonical" href="https://music.the816.com/explore/">';
    window.history.replaceState({}, "", "/explore/?grain=year&view=table");
    render(<ExplorerFilter defaultState={parseExplorerState(new URLSearchParams())} />);

    await waitFor(() =>
      expect((screen.getByLabelText("Time grain") as HTMLSelectElement).value).toBe("year"),
    );
    expect((screen.getByLabelText("Reading mode") as HTMLSelectElement).value).toBe("table");
    expect(document.querySelector("link[rel='canonical']")?.getAttribute("href")).toBe(
      "https://music.the816.com/explore/?grain=year&view=table",
    );
  });

  it("updates the share link as controls change before form submission", () => {
    render(<ExplorerFilter defaultState={parseExplorerState(new URLSearchParams())} />);

    fireEvent.change(screen.getByLabelText("Time grain"), { target: { value: "year" } });
    fireEvent.change(screen.getByLabelText("Reading mode"), { target: { value: "table" } });

    expect(
      screen.getByRole("link", { name: /https:\/\/music\.the816\.com/u }).getAttribute("href"),
    ).toBe("/explore/?grain=year&view=table");
  });

  it("does not reflect rejected query values into the document", async () => {
    window.history.replaceState({}, "", "/explore/?grain=day&artist=private-tail");
    const result = render(
      <ExplorerFilter defaultState={parseExplorerState(new URLSearchParams())} />,
    );

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/ignored/u));
    expect(result.container.textContent).not.toContain("private-tail");
  });
});
