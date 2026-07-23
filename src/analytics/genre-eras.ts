import type { JsonObject } from "../cli/result.ts";
import type { SqliteConnection } from "../db/connection.ts";
import {
  generateGenreContributions,
  type GenreContributionMode,
  type GenreContributionResult,
} from "../genre/contributions.ts";
import { IDENTITY_RESOLUTION_RULE_VERSION } from "../identity/resolution.ts";
import { queryCanonicalAnalyticalBase } from "./base.ts";
import {
  AnalyticalResultContractError,
  createAnalyticalResult,
  validateAnalyticalParameters,
  type AnalyticalParameterDefinition,
  type AnalyticalResult,
} from "./result.ts";

export const GENRE_ERA_ANALYSIS_VERSION = "genre-era-v1";
export const GENRE_ERA_PARAMETER_SCHEMA_VERSION = "genre-era-parameters-v1";
export const GENRE_ERA_QUERY_VERSION = "canonical-genre-era-v1";

export const DEFAULT_GENRE_ERA_PARAMETERS = {
  maximumRank: 20,
  minimumConsecutiveActiveWindows: 2,
  minimumEarlierBaselineChange: -12,
  minimumListeningShare: 0.02,
  minimumRollingContribution: 12,
  minimumWindowContribution: 3,
  rollingWindowCount: 4,
  windowSizeMonths: 3,
} as const;

export interface GenreEraParameters extends JsonObject {
  readonly maximumRank: number;
  readonly minimumConsecutiveActiveWindows: number;
  readonly minimumEarlierBaselineChange: number;
  readonly minimumListeningShare: number;
  readonly minimumRollingContribution: number;
  readonly minimumWindowContribution: number;
  readonly rollingWindowCount: number;
  readonly windowSizeMonths: number;
}

export interface GenreEraWindowComponents extends JsonObject {
  readonly consecutiveActiveWindows: number;
  readonly earlierBaselineChange: number | null;
  readonly earlierBaselineRollingContribution: number | null;
  readonly isQualified: boolean;
  readonly listeningShare: number;
  readonly rank: number;
  readonly rollingContribution: number;
  readonly strength: number;
  readonly windowContribution: number;
}

export interface GenreEraInterval extends JsonObject {
  readonly contribution: number;
  readonly evidence: readonly {
    readonly components: GenreEraWindowComponents;
    readonly windowEndExclusive: string;
    readonly windowStart: string;
  }[];
  readonly genreId: string;
  readonly genreLabel: string;
  readonly peak: { readonly components: GenreEraWindowComponents; readonly windowStart: string };
  readonly share: number;
  readonly strength: number;
  readonly windowEndExclusive: string;
  readonly windowStart: string;
}

export interface GenreEraResult extends JsonObject {
  readonly coverage: JsonObject;
  readonly fetchAge: JsonObject;
  readonly intervals: readonly GenreEraInterval[];
  readonly mode: GenreContributionMode;
  readonly provider: "musicbrainz";
  readonly taxonomyVersion: string | null;
  readonly weightingLevel: "artist";
}

export interface GenerateGenreEraAnalysisOptions {
  readonly connection: SqliteConnection;
  readonly mode: GenreContributionMode;
  readonly now?: () => number;
  readonly parameters?: unknown;
  readonly presentationTimezone: string;
  readonly refreshAgeMs?: number;
  readonly taxonomyVersion?: string;
}

interface Month {
  readonly year: number;
  readonly month: number;
}
interface GenreWindow extends Month {
  readonly genreId: string;
  readonly genreLabel: string;
  readonly components: GenreEraWindowComponents;
}

export const GENRE_ERA_PARAMETER_DEFINITION: AnalyticalParameterDefinition<GenreEraParameters> = {
  schemaVersion: GENRE_ERA_PARAMETER_SCHEMA_VERSION,
  validate(input: unknown): GenreEraParameters {
    if (!isObject(input))
      throw new AnalyticalResultContractError("Genre-era parameters must be an object");
    const allowed = new Set(Object.keys(DEFAULT_GENRE_ERA_PARAMETERS));
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw new AnalyticalResultContractError("Genre-era parameters contain an unsupported field");
    const values = { ...DEFAULT_GENRE_ERA_PARAMETERS, ...input };
    for (const key of [
      "windowSizeMonths",
      "rollingWindowCount",
      "maximumRank",
      "minimumConsecutiveActiveWindows",
    ] as const) {
      if (!isPositiveInteger(values[key]))
        throw new AnalyticalResultContractError(`Genre-era ${key} must be a positive safe integer`);
    }
    if (
      values.windowSizeMonths > 12 ||
      values.rollingWindowCount > 24 ||
      values.maximumRank > 100_000 ||
      values.minimumConsecutiveActiveWindows > 100
    )
      throw new AnalyticalResultContractError(
        "Genre-era integer parameter exceeds its supported maximum",
      );
    for (const key of ["minimumWindowContribution", "minimumRollingContribution"] as const) {
      if (!isPositiveNumber(values[key]))
        throw new AnalyticalResultContractError(
          `Genre-era ${key} must be a positive finite number`,
        );
    }
    if (!Number.isFinite(values.minimumEarlierBaselineChange))
      throw new AnalyticalResultContractError(
        "Genre-era minimumEarlierBaselineChange must be finite",
      );
    if (!isPositiveNumber(values.minimumListeningShare) || values.minimumListeningShare > 1)
      throw new AnalyticalResultContractError(
        "Genre-era minimumListeningShare must be greater than zero and no greater than one",
      );
    return values;
  },
};

/** Computes coverage-qualified fractional genre intervals from the P5-06 contribution snapshot. */
export function generateGenreEraAnalysis(
  options: GenerateGenreEraAnalysisOptions,
): AnalyticalResult<GenreEraResult> {
  const validated = validateAnalyticalParameters(
    GENRE_ERA_PARAMETER_DEFINITION,
    options.parameters ?? {},
  );
  const parameters = validated.values;
  return options.connection.transaction((connection) => {
    const contributions = generateGenreContributions({ ...options, connection });
    const events = queryCanonicalAnalyticalBase(connection, options.presentationTimezone);
    const eventMonths = new Map(
      events.map((event) => [event.listeningEventId, parseMonth(event.calendar.month)]),
    );
    const windows = calculateWindows(
      contributions,
      eventMonths,
      events.map((event) => event.calendar.month),
      parameters,
    );
    const eventCount = events.length;
    const firstEvent = events.at(0);
    const lastEvent = events.at(-1);
    const dateRange =
      firstEvent === undefined || lastEvent === undefined
        ? null
        : {
            startInclusive: new Date(firstEvent.calendarInstantEpochMs).toISOString(),
            endExclusive: new Date(lastEvent.calendarInstantEpochMs + 1).toISOString(),
          };
    const usable = contributions.coverage.usable.eventCount;
    return createAnalyticalResult<GenreEraResult>({
      analysis: "genre-eras",
      asOf: dateRange?.endExclusive ?? null,
      dateRange,
      definition:
        "Calendar-aligned genre eras are consecutive qualifying windows over fractional artist-level genre contributions. Unenriched events remain missing metadata; coverage and provider freshness visibly qualify every result.",
      eventCount,
      includedSources: ["lastfm", "spotify"],
      metadataCoverage: {
        usableGenre: {
          availableEventCount: usable,
          totalEventCount: eventCount,
          rate: eventCount === 0 ? 0 : usable / eventCount,
        },
      },
      parameters,
      presentationTimezone: options.presentationTimezone,
      result: {
        coverage: contributions.coverage as unknown as JsonObject,
        fetchAge: contributions.freshness as unknown as JsonObject,
        intervals: assembleIntervals(windows, parameters.windowSizeMonths),
        mode: contributions.mode,
        provider: contributions.provider,
        taxonomyVersion: contributions.taxonomyVersion,
        weightingLevel: contributions.weightingLevel,
      },
      unresolvedRate:
        eventCount === 0
          ? 0
          : events.filter((event) => event.eventStatus === "unresolved").length / eventCount,
      versions: {
        analysis: GENRE_ERA_ANALYSIS_VERSION,
        identityRules: [IDENTITY_RESOLUTION_RULE_VERSION],
        parameterSchema: validated.schemaVersion,
        query: GENRE_ERA_QUERY_VERSION,
        reconciliationRules: unique(
          events.map((event) => event.reconciliationRuleVersion),
          "canonical-event-v1",
        ),
      },
    });
  }, "deferred");
}

function calculateWindows(
  contributions: GenreContributionResult,
  eventMonths: ReadonlyMap<number, Month>,
  calendarMonths: readonly string[],
  p: GenreEraParameters,
): readonly GenreWindow[] {
  const firstMonth = calendarMonths.at(0);
  const lastMonth = calendarMonths.at(-1);
  if (firstMonth === undefined || lastMonth === undefined) return [];
  const first = parseMonth(firstMonth);
  const last = parseMonth(lastMonth);
  const keys = range(first, last, p.windowSizeMonths);
  const values = new Map<string, Map<number, number>>();
  const labels = new Map<string, string>();
  for (const event of contributions.eventContributions)
    for (const item of event.contributions) {
      const month = eventMonths.get(event.listeningEventId);
      if (month === undefined) continue;
      const counts = values.get(item.genreId) ?? new Map<number, number>();
      const index = monthIndex(align(month, p.windowSizeMonths));
      counts.set(index, (counts.get(index) ?? 0) + item.contribution);
      values.set(item.genreId, counts);
      labels.set(item.genreId, item.genreLabel);
    }
  const output: GenreWindow[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const current = new Map(
      [...values].map(([id, counts]) => [id, keys.map((key) => counts.get(monthIndex(key)) ?? 0)]),
    );
    const rolling = new Map(
      [...current].map(([id, counts]) => [
        id,
        counts.map((_, index) =>
          sum(counts.slice(Math.max(0, index - p.rollingWindowCount + 1), index + 1)),
        ),
      ]),
    );
    const ranks = denseRanks([...rolling].map(([id, counts]) => ({ id, value: counts[i] ?? 0 })));
    const total = sum([...rolling.values()].map((counts) => counts[i] ?? 0));
    for (const [genreId, count] of current) {
      const rollingCounts = rolling.get(genreId);
      const key = keys[i];
      const genreLabel = labels.get(genreId);
      if (rollingCounts === undefined || key === undefined || genreLabel === undefined)
        throw new Error("Genre-era window calculation lost derived genre data");
      const windowContribution = count[i] ?? 0;
      const rollingContribution = rollingCounts[i] ?? 0;
      const baselineEnd = i - p.rollingWindowCount;
      const earlier =
        baselineEnd - p.rollingWindowCount + 1 < 0
          ? null
          : sum(count.slice(baselineEnd - p.rollingWindowCount + 1, baselineEnd + 1));
      let consecutive = 0;
      for (
        let cursor = i;
        cursor >= 0 &&
        (count[cursor] ?? 0) >= p.minimumWindowContribution &&
        (rollingCounts[cursor] ?? 0) >= p.minimumRollingContribution;
        cursor -= 1
      )
        consecutive += 1;
      const change = earlier === null ? null : rollingContribution - earlier;
      const share = total === 0 ? 0 : rollingContribution / total;
      const qualified =
        windowContribution >= p.minimumWindowContribution &&
        rollingContribution >= p.minimumRollingContribution &&
        share >= p.minimumListeningShare &&
        (ranks.get(genreId) ?? 1) <= p.maximumRank &&
        consecutive >= p.minimumConsecutiveActiveWindows &&
        (change === null || change >= p.minimumEarlierBaselineChange);
      const scores = [
        ratio(windowContribution, p.minimumWindowContribution),
        ratio(rollingContribution, p.minimumRollingContribution),
        ratio(share, p.minimumListeningShare),
        ratio(p.maximumRank + 1 - (ranks.get(genreId) ?? 1), p.maximumRank),
        ratio(consecutive, p.minimumConsecutiveActiveWindows),
        ...(change === null
          ? []
          : [ratio(change - p.minimumEarlierBaselineChange, p.minimumRollingContribution)]),
      ];
      output.push({
        ...key,
        genreId,
        genreLabel,
        components: {
          consecutiveActiveWindows: consecutive,
          earlierBaselineChange: change,
          earlierBaselineRollingContribution: earlier,
          isQualified: qualified,
          listeningShare: share,
          rank: ranks.get(genreId) ?? 1,
          rollingContribution,
          strength: sum(scores) / scores.length,
          windowContribution,
        },
      });
    }
  }
  return output;
}

function assembleIntervals(
  windows: readonly GenreWindow[],
  size: number,
): readonly GenreEraInterval[] {
  const grouped = new Map<string, GenreWindow[]>();
  for (const window of windows)
    grouped.set(window.genreId, [...(grouped.get(window.genreId) ?? []), window]);
  const intervals: GenreEraInterval[] = [];
  for (const group of grouped.values()) {
    let qualifying: GenreWindow[] = [];
    for (const window of group) {
      if (window.components.isQualified) qualifying.push(window);
      else {
        if (qualifying.length) intervals.push(interval(qualifying, size));
        qualifying = [];
      }
    }
    if (qualifying.length) intervals.push(interval(qualifying, size));
  }
  return intervals.sort((a, b) =>
    a.windowStart === b.windowStart
      ? compare(a.genreId, b.genreId)
      : compare(a.windowStart, b.windowStart),
  );
}
function interval(windows: readonly GenreWindow[], size: number): GenreEraInterval {
  const first = windows.at(0);
  const last = windows.at(-1);
  if (first === undefined || last === undefined)
    throw new Error("Genre-era interval requires at least one qualifying window");
  const peak = windows.reduce((best, item) =>
    item.components.strength > best.components.strength ||
    (item.components.strength === best.components.strength &&
      (item.components.rollingContribution > best.components.rollingContribution ||
        (item.components.rollingContribution === best.components.rollingContribution &&
          monthIndex(item) < monthIndex(best))))
      ? item
      : best,
  );
  return {
    contribution: sum(windows.map((item) => item.components.windowContribution)),
    evidence: windows.map((item) => ({
      components: item.components,
      windowStart: format(item),
      windowEndExclusive: format(add(item, size)),
    })),
    genreId: first.genreId,
    genreLabel: first.genreLabel,
    peak: { components: peak.components, windowStart: format(peak) },
    share: sum(windows.map((item) => item.components.listeningShare)) / windows.length,
    strength: peak.components.strength,
    windowStart: format(first),
    windowEndExclusive: format(add(last, size)),
  };
}
function parseMonth(value: string): Month {
  const match = /^(\d{4,})-(\d{2})$/u.exec(value);
  if (!match) throw new Error("Genre-era event has an invalid calendar month");
  return { year: Number(match[1]), month: Number(match[2]) };
}
function range(first: Month, last: Month, size: number): Month[] {
  const output: Month[] = [];
  for (
    let current = align(first, size);
    monthIndex(current) <= monthIndex(last);
    current = add(current, size)
  )
    output.push(current);
  return output;
}
function align(month: Month, size: number): Month {
  const offset = monthIndex(month) - monthIndex({ year: 1970, month: 1 });
  return add({ year: 1970, month: 1 }, offset - modulo(offset, size));
}
function add(month: Month, count: number): Month {
  const index = monthIndex(month) + count;
  return { year: Math.floor(index / 12), month: modulo(index, 12) + 1 };
}
function monthIndex(month: Month): number {
  return month.year * 12 + month.month - 1;
}
function format(month: Month): string {
  return `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}`;
}
function denseRanks(
  values: readonly { readonly id: string; readonly value: number }[],
): ReadonlyMap<string, number> {
  const ordered = [...values].sort((a, b) => b.value - a.value || compare(a.id, b.id));
  const result = new Map<string, number>();
  let rank = 0;
  let previous: number | undefined;
  for (const value of ordered) {
    if (value.value !== previous) rank += 1;
    result.set(value.id, rank);
    previous = value.value;
  }
  return result;
}
function ratio(value: number, denominator: number): number {
  return Math.max(0, Math.min(1, value / denominator));
}
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
function unique(values: readonly string[], fallback: string): readonly string[] {
  const filtered = values.filter(Boolean);
  return filtered.length ? [...new Set(filtered)].sort() : [fallback];
}
function compare(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
