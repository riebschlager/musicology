import { describe, expect, it } from "vitest";

import { loadSiteSnapshot, type PublicHistoryData } from "../src/adapters/public-snapshot.ts";
import {
  buildLongViewModel,
  buildLongViewState,
  parseLongViewState,
} from "../src/view-models/long-view.ts";

const snapshot = loadSiteSnapshot({ fixture: "full", projectRoot: process.cwd() });

describe("long-view state and view model", () => {
  it("reconciles the default table total exactly to the public fixture", () => {
    const state = parseLongViewState(new URLSearchParams(), snapshot.history.data.periods, {
      allowRange: true,
    });
    const model = buildLongViewModel(
      { asOfDate: snapshot.manifest.asOfDate, history: snapshot.history.data },
      state,
    );

    expect(state.canonicalSearch).toBe("");
    expect(model.totalPlayCount).toBe(snapshot.history.data.totalPlayCount);
    expect(model.periods.reduce((sum, row) => sum + row.playCount, 0)).toBe(30);
    expect(model.findings.join(" ")).toMatch(/counted once/u);
  });

  it("uses a canonical yearly default for the history route contract", () => {
    const state = parseLongViewState(new URLSearchParams(), snapshot.history.data.periods, {
      allowRange: true,
      defaultGrain: "year",
    });
    const model = buildLongViewModel(
      { asOfDate: snapshot.manifest.asOfDate, history: snapshot.history.data },
      state,
    );

    expect(state).toMatchObject({ canonicalSearch: "", grain: "year" });
    expect(model.periods.map((row) => [row.period, row.playCount])).toEqual([["2020", 30]]);

    const explicitMonth = parseLongViewState(
      new URLSearchParams("grain=month"),
      snapshot.history.data.periods,
      { allowRange: true, defaultGrain: "year" },
    );
    expect(explicitMonth.canonicalSearch).toBe("?grain=month");
  });

  it("regroups only approved monthly rows and applies inclusive bounded months", () => {
    const state = parseLongViewState(
      new URLSearchParams("from=2020-04&to=2020-09&grain=quarter&view=table"),
      snapshot.history.data.periods,
      { allowRange: true },
    );
    const model = buildLongViewModel(
      { asOfDate: snapshot.manifest.asOfDate, history: snapshot.history.data },
      state,
    );

    expect(state.canonicalSearch).toBe("?from=2020-04&to=2020-09&grain=quarter&view=table");
    expect(model.periods.map((row) => [row.period, row.playCount])).toEqual([
      ["2020-Q2", 9],
      ["2020-Q3", 6],
    ]);
    expect(model.totalPlayCount).toBe(15);
  });

  it("falls back without reflecting unsupported, duplicate, or out-of-range URL state", () => {
    const state = parseLongViewState(
      new URLSearchParams(
        "from=1999-01&to=2099-12&grain=day&artist=private-tail&view=chart&view=table",
      ),
      snapshot.history.data.periods,
      { allowRange: true },
    );

    expect(state).toMatchObject({
      canonicalSearch: "",
      from: "2020-01",
      grain: "month",
      to: "2020-12",
      view: "chart",
    });
    expect(state.notice).toMatch(/ignored/u);
    expect(JSON.stringify(state)).not.toContain("private-tail");

    expect(
      buildLongViewState(snapshot.history.data.periods, {
        allowRange: true,
        from: "2020-09",
        grain: "month",
        to: "2020-04",
        view: "chart",
      }),
    ).toMatchObject({ canonicalSearch: "", from: "2020-01", to: "2020-12" });
  });

  it("makes early Last.fm-only history, the 2017–2024 absence, and the recent edge textual", () => {
    const history: PublicHistoryData = {
      ...snapshot.history.data,
      periods: [
        historyPeriod("2005-02", 4),
        historyPeriod("2016-12", 5),
        historyPeriod("2020-06", 6),
        historyPeriod("2025-01", 7),
        historyPeriod("2026-04", 8),
      ],
      sourceCoverage: [
        {
          byYear: [
            { evidenceCount: 4, period: "2005" },
            { evidenceCount: 5, period: "2016" },
            { evidenceCount: 7, period: "2025" },
            { evidenceCount: 8, period: "2026" },
          ],
          longGaps: [{ afterPeriod: "2016-12", beforePeriod: "2025-01", durationDays: 2_923 }],
          observedEndPeriod: "2026-04",
          observedStartPeriod: "2005-02",
          source: "lastfm",
        },
        {
          byYear: [
            { evidenceCount: 5, period: "2016" },
            { evidenceCount: 6, period: "2020" },
            { evidenceCount: 7, period: "2025" },
            { evidenceCount: 8, period: "2026" },
          ],
          longGaps: [],
          observedEndPeriod: "2026-04",
          observedStartPeriod: "2011-08",
          source: "spotify",
        },
      ],
      totalPlayCount: 30,
    };
    const state = buildLongViewState(history.periods, {
      allowRange: true,
      from: "2005-02",
      grain: "year",
      to: "2026-04",
      view: "chart",
    });
    const model = buildLongViewModel({ asOfDate: "2026-04-26", history }, state);
    const findings = model.findings.join(" ");

    expect(findings).toMatch(/Last\.fm-only evidence in Feb 2005/u);
    expect(findings).toMatch(/after Dec 2016 and before Jan 2025/u);
    expect(findings).toMatch(/2017 through 2024 without Last\.fm evidence/u);
    expect(findings).toMatch(/gap in evidence, not proof of no listening/u);
    expect(findings).toMatch(/right-censored/u);
    expect(model.periods.find((row) => row.period === "2020")?.coverageCategory).toBe(
      "Source gap or boundary",
    );
    expect(model.periods.find((row) => row.period === "2016")?.coverageCategory).toBe(
      "Both sources in year",
    );
    expect(model.periods.find((row) => row.period === "2025")?.coverageCategory).toBe(
      "Both sources in year",
    );

    const boundaryState = buildLongViewState(history.periods, {
      allowRange: true,
      from: "2016-12",
      grain: "month",
      to: "2016-12",
      view: "chart",
    });
    const boundary = buildLongViewModel({ asOfDate: "2026-04-26", history }, boundaryState);
    expect(boundary.periods[0]).toMatchObject({
      coverageCategory: "Both sources in year",
      period: "2016-12",
    });
    expect(boundary.periods[0]?.coverageNote).toMatch(
      /2016 annual coverage.*Exact source backing for this sub-year period is not published/u,
    );
  });

  it("does not invent zero-valued history for the empty public fixture", () => {
    const empty = loadSiteSnapshot({ fixture: "empty", projectRoot: process.cwd() });
    const state = parseLongViewState(new URLSearchParams(), empty.history.data.periods, {
      allowRange: true,
    });
    const model = buildLongViewModel(
      { asOfDate: empty.manifest.asOfDate, history: empty.history.data },
      state,
    );

    expect(model.periods).toEqual([]);
    expect(model.totalPlayCount).toBe(0);
    expect(model.findings[0]).toMatch(/does not invent/u);
  });
});

function historyPeriod(period: string, playCount: number) {
  return {
    period,
    playCount,
    priorYearPlayCount: null,
    rollingPlayCount: playCount,
    yearOverYearAbsoluteChange: null,
    yearOverYearRate: null,
  };
}
