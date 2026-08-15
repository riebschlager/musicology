import type { PublicHistoryData } from "../adapters/public-snapshot.ts";
import { formatMonth, formatNumber } from "./site.ts";

const GRAINS = ["month", "quarter", "year"] as const;
const VIEWS = ["chart", "table"] as const;

export type LongViewGrain = (typeof GRAINS)[number];
export type LongViewMode = (typeof VIEWS)[number];

export interface LongViewState {
  readonly canonicalSearch: string;
  readonly from: string | null;
  readonly grain: LongViewGrain;
  readonly notice: string | null;
  readonly to: string | null;
  readonly view: LongViewMode;
}

export interface LongViewPeriod {
  readonly coverageCategory:
    | "Both sources in year"
    | "Last.fm in year"
    | "Spotify in year"
    | "Source gap or boundary";
  readonly coverageNote: string;
  readonly label: string;
  readonly period: string;
  readonly playCount: number;
}

export interface LongViewYearCoverage {
  readonly lastfmEvidenceCount: number | null;
  readonly overlapEventCount: number;
  readonly spotifyEvidenceCount: number | null;
  readonly year: string;
}

export interface LongViewModel {
  readonly findings: readonly string[];
  readonly periods: readonly LongViewPeriod[];
  readonly rangeLabel: string;
  readonly sourceCoverage: readonly LongViewYearCoverage[];
  readonly totalPlayCount: number;
}

interface ParseOptions {
  readonly allowRange: boolean;
  readonly defaultGrain?: LongViewGrain;
}

interface BuildStateOptions extends ParseOptions {
  readonly from: string | null;
  readonly grain: LongViewGrain;
  readonly to: string | null;
  readonly view: LongViewMode;
}

interface LongViewContext {
  readonly asOfDate: string | null;
  readonly history: PublicHistoryData;
}

export function parseLongViewState(
  searchParams: URLSearchParams,
  periods: PublicHistoryData["periods"],
  options: ParseOptions,
): LongViewState {
  const bounds = historyBounds(periods);
  const defaultGrain = options.defaultGrain ?? "month";
  const requestedGrain = searchParams.get("grain");
  const requestedView = searchParams.get("view");
  const requestedFrom = options.allowRange ? searchParams.get("from") : null;
  const requestedTo = options.allowRange ? searchParams.get("to") : null;
  const grain = isOneOf(requestedGrain, GRAINS) ? requestedGrain : defaultGrain;
  const view = isOneOf(requestedView, VIEWS) ? requestedView : "chart";
  const allowedKeys = options.allowRange
    ? new Set(["from", "grain", "to", "view"])
    : new Set(["grain", "view"]);
  const unsupported = [...searchParams.keys()].some(
    (key) => !allowedKeys.has(key) || searchParams.getAll(key).length !== 1,
  );
  const invalidControl =
    (requestedGrain !== null && !isOneOf(requestedGrain, GRAINS)) ||
    (requestedView !== null && !isOneOf(requestedView, VIEWS));
  const requestedRange =
    bounds === null
      ? { from: null, invalid: requestedFrom !== null || requestedTo !== null, to: null }
      : parseRange(requestedFrom, requestedTo, bounds.first, bounds.last);
  const state = buildLongViewState(periods, {
    ...options,
    defaultGrain,
    from: requestedRange.invalid ? (bounds?.first ?? null) : requestedRange.from,
    grain,
    to: requestedRange.invalid ? (bounds?.last ?? null) : requestedRange.to,
    view,
  });

  return {
    ...state,
    notice:
      unsupported || invalidControl || requestedRange.invalid
        ? "Unsupported or out-of-range link options were ignored; this view uses the nearest safe public default."
        : null,
  };
}

export function buildLongViewState(
  periods: PublicHistoryData["periods"],
  options: BuildStateOptions,
): LongViewState {
  const bounds = historyBounds(periods);
  const defaultGrain = options.defaultGrain ?? "month";
  const canonical = new URLSearchParams();
  const requestedRange =
    options.allowRange && bounds !== null
      ? parseRange(options.from, options.to, bounds.first, bounds.last)
      : null;
  const from = options.allowRange
    ? requestedRange?.invalid
      ? (bounds?.first ?? null)
      : (requestedRange?.from ?? null)
    : (bounds?.first ?? null);
  const to = options.allowRange
    ? requestedRange?.invalid
      ? (bounds?.last ?? null)
      : (requestedRange?.to ?? null)
    : (bounds?.last ?? null);

  if (options.allowRange && bounds !== null) {
    if (from !== null && from !== bounds.first) canonical.set("from", from);
    if (to !== null && to !== bounds.last) canonical.set("to", to);
  }
  if (options.grain !== defaultGrain) canonical.set("grain", options.grain);
  if (options.view !== "chart") canonical.set("view", options.view);

  return {
    canonicalSearch: canonical.size === 0 ? "" : `?${canonical.toString()}`,
    from,
    grain: options.grain,
    notice: null,
    to,
    view: options.view,
  };
}

export function buildLongViewModel(context: LongViewContext, state: LongViewState): LongViewModel {
  const selected = context.history.periods.filter(
    (row) =>
      (state.from === null || row.period >= state.from) &&
      (state.to === null || row.period <= state.to),
  );
  const grouped = new Map<string, { playCount: number; start: string; end: string }>();

  for (const row of selected) {
    const key = periodKey(row.period, state.grain);
    const existing = grouped.get(key);
    grouped.set(key, {
      end: row.period,
      playCount: (existing?.playCount ?? 0) + row.playCount,
      start: existing?.start ?? row.period,
    });
  }

  const periods = [...grouped.entries()].map(([period, aggregate]) => {
    const coverage = coverageForRange(context.history, aggregate.start, aggregate.end, state.grain);
    return {
      coverageCategory: coverage.category,
      coverageNote: coverage.note,
      label: periodLabel(period, state.grain),
      period,
      playCount: aggregate.playCount,
    } satisfies LongViewPeriod;
  });
  const totalPlayCount = periods.reduce((sum, row) => sum + row.playCount, 0);
  const selectedStart = selected.at(0)?.period ?? state.from;
  const selectedEnd = selected.at(-1)?.period ?? state.to;
  const sourceCoverage = buildYearCoverage(context.history, selectedStart, selectedEnd);

  return {
    findings: buildFindings(context, selectedStart, selectedEnd, totalPlayCount),
    periods,
    rangeLabel:
      selectedStart === null || selectedEnd === null
        ? "No reviewed period"
        : `${formatMonth(selectedStart)}–${formatMonth(selectedEnd)}`,
    sourceCoverage,
    totalPlayCount,
  };
}

function buildFindings(
  context: LongViewContext,
  selectedStart: string | null,
  selectedEnd: string | null,
  totalPlayCount: number,
): readonly string[] {
  if (selectedStart === null || selectedEnd === null) {
    return [
      "No reviewed monthly history is available, so this view does not invent a zero-valued timeline.",
    ];
  }

  const history = context.history;
  const lastfm = history.sourceCoverage.find((source) => source.source === "lastfm");
  const spotify = history.sourceCoverage.find((source) => source.source === "spotify");
  const findings = [
    `${formatNumber(totalPlayCount)} canonical plays fall within ${formatMonth(selectedStart)} through ${formatMonth(selectedEnd)}. Every canonical event is counted once, including reconciled overlap.`,
  ];

  if (
    lastfm?.observedStartPeriod &&
    spotify?.observedStartPeriod &&
    lastfm.observedStartPeriod < spotify.observedStartPeriod
  ) {
    findings.push(
      `The retained record begins with Last.fm-only evidence in ${formatMonth(lastfm.observedStartPeriod)}; Spotify evidence begins later, in ${formatMonth(spotify.observedStartPeriod)}. Early volume is listening evidence, but it has no Spotify duration coverage.`,
    );
  } else {
    findings.push(
      "Source backing must be read period by period. A source that begins later cannot supply duration or corroboration for the earlier record.",
    );
  }

  const gaps = history.sourceCoverage.flatMap((source) =>
    source.longGaps
      .filter((gap) => gap.beforePeriod >= selectedStart && gap.afterPeriod <= selectedEnd)
      .map((gap) => {
        const fullYears = fullCalendarYearsBetween(gap.afterPeriod, gap.beforePeriod);
        const knownAbsence =
          source.source === "lastfm" && fullYears !== null
            ? ` This leaves ${fullYears} without Last.fm evidence.`
            : "";
        return `${sourceName(source.source)} has a documented gap after ${formatMonth(gap.afterPeriod)} and before ${formatMonth(gap.beforePeriod)} (${formatNumber(gap.durationDays)} days).${knownAbsence} This suspicious discontinuity is a gap in evidence, not proof of no listening.`;
      }),
  );
  findings.push(
    ...(gaps.length > 0
      ? gaps
      : [
          "No documented long source gap intersects this selection, but source evidence can still be sparse or partial.",
        ]),
  );

  const fullEnd = history.periods.at(-1)?.period;
  if (fullEnd !== undefined) {
    findings.push(
      `The record's latest public month is ${formatMonth(fullEnd)}${context.asOfDate === null ? "" : `, with an analytical as-of date of ${context.asOfDate}`}. That recent edge is right-censored: it has had less time to accumulate evidence and should not be read as a completed period.`,
    );
  }
  return findings;
}

function buildYearCoverage(
  history: PublicHistoryData,
  start: string | null,
  end: string | null,
): readonly LongViewYearCoverage[] {
  if (start === null || end === null) return [];
  const years = new Set<string>();
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year += 1) {
    years.add(String(year));
  }
  const source = (name: "lastfm" | "spotify") =>
    history.sourceCoverage.find((item) => item.source === name);
  const lastfm = source("lastfm");
  const spotify = source("spotify");
  const overlap = new Map(history.overlapByYear.map((row) => [row.period, row.eventCount]));
  return [...years].map((year) => ({
    lastfmEvidenceCount: lastfm?.byYear.find((row) => row.period === year)?.evidenceCount ?? null,
    overlapEventCount: overlap.get(year) ?? 0,
    spotifyEvidenceCount: spotify?.byYear.find((row) => row.period === year)?.evidenceCount ?? null,
    year,
  }));
}

function coverageForRange(
  history: PublicHistoryData,
  start: string,
  end: string,
  grain: LongViewGrain,
): { readonly category: LongViewPeriod["coverageCategory"]; readonly note: string } {
  const statuses = (["lastfm", "spotify"] as const).map((sourceName) => {
    const source = history.sourceCoverage.find((item) => item.source === sourceName);
    const observed =
      source?.observedStartPeriod !== null &&
      source?.observedStartPeriod !== undefined &&
      source.observedEndPeriod !== null &&
      start <= source.observedEndPeriod &&
      end >= source.observedStartPeriod;
    const annualEvidence = source?.byYear.some(
      (row) =>
        row.period >= start.slice(0, 4) && row.period <= end.slice(0, 4) && row.evidenceCount > 0,
    );
    const gap = source?.longGaps.some(
      (item) => item.afterPeriod < end && item.beforePeriod > start,
    );
    return { annualEvidence: observed && annualEvidence, gap: gap ?? false, source: sourceName };
  });
  const lastfm = statuses[0];
  const spotify = statuses[1];
  if (lastfm === undefined || spotify === undefined) {
    return { category: "Source gap or boundary", note: "Source context is unavailable." };
  }
  if (lastfm.gap || spotify.gap) {
    const names = statuses
      .filter((status) => status.gap)
      .map((status) => sourceName(status.source));
    return {
      category: "Source gap or boundary",
      note: `${names.join(" and ")} documented gap or boundary; do not infer no listening.`,
    };
  }
  const annualScope = grain === "year" ? "this year" : `the ${start.slice(0, 4)} annual coverage`;
  const precisionNote =
    grain === "year" ? "" : " Exact source backing for this sub-year period is not published.";
  if (lastfm.annualEvidence && spotify.annualEvidence) {
    return {
      category: "Both sources in year",
      note: `Last.fm and Spotify evidence occur in ${annualScope}.${precisionNote}`,
    };
  }
  if (lastfm.annualEvidence) {
    return {
      category: "Last.fm in year",
      note: `Only Last.fm evidence occurs in ${annualScope}; no Spotify duration coverage.${precisionNote}`,
    };
  }
  if (spotify.annualEvidence) {
    return {
      category: "Spotify in year",
      note: `Only Spotify evidence occurs in ${annualScope}; a Last.fm gap is not no listening.${precisionNote}`,
    };
  }
  return {
    category: "Source gap or boundary",
    note: "No source evidence is listed for this aggregate period; do not interpret it as zero listening.",
  };
}

function parseRange(
  requestedFrom: string | null,
  requestedTo: string | null,
  first: string,
  last: string,
): { readonly from: string; readonly invalid: boolean; readonly to: string } {
  const from = requestedFrom ?? first;
  const to = requestedTo ?? last;
  const invalid = !isMonth(from) || !isMonth(to) || from < first || to > last || from > to;
  return { from, invalid, to };
}

function historyBounds(
  periods: PublicHistoryData["periods"],
): { readonly first: string; readonly last: string } | null {
  const first = periods.at(0)?.period;
  const last = periods.at(-1)?.period;
  return first === undefined || last === undefined ? null : { first, last };
}

function periodKey(month: string, grain: LongViewGrain): string {
  if (grain === "month") return month;
  const year = month.slice(0, 4);
  if (grain === "year") return year;
  const monthNumber = Number(month.slice(5, 7));
  return `${year}-Q${Math.ceil(monthNumber / 3)}`;
}

function periodLabel(period: string, grain: LongViewGrain): string {
  return grain === "month" ? formatMonth(period) : period.replace("-", " ");
}

function isMonth(value: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value);
}

function fullCalendarYearsBetween(afterPeriod: string, beforePeriod: string): string | null {
  const first = Number(afterPeriod.slice(0, 4)) + 1;
  const last = Number(beforePeriod.slice(0, 4)) - 1;
  if (first > last) return null;
  return first === last ? String(first) : `${first} through ${last}`;
}

function sourceName(source: "lastfm" | "spotify"): string {
  return source === "lastfm" ? "Last.fm" : "Spotify";
}

function isOneOf<T extends string>(value: string | null, choices: readonly T[]): value is T {
  return value !== null && choices.some((choice) => choice === value);
}
