import type { JsonObject } from "../cli/result.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { IDENTITY_RESOLUTION_RULE_VERSION } from "../identity/resolution.ts";
import { queryCanonicalAnalyticalBase, type CanonicalAnalyticalBaseEvent } from "./base.ts";
import {
  ARTIST_ERA_PARAMETER_DEFINITION,
  evaluateArtistEraWindow,
  type ArtistEraWindowComponents,
  type ArtistEraParameters,
} from "./artist-era.ts";
import {
  createAnalyticalResult,
  validateAnalyticalParameters,
  type AnalyticalResult,
} from "./result.ts";

export const ARTIST_ERA_ANALYSIS_VERSION = "artist-era-v1";
export const ARTIST_ERA_QUERY_VERSION = "canonical-artist-era-v1";

export interface ArtistEraWindowEvidence extends JsonObject {
  readonly components: ArtistEraWindowComponents;
  readonly windowEndExclusive: string;
  readonly windowStart: string;
}

export interface ArtistEraPeak extends JsonObject {
  readonly components: ArtistEraWindowComponents;
  readonly windowStart: string;
}

export interface ArtistEraInterval extends JsonObject {
  readonly artistDisplayName: string;
  readonly artistId: number;
  readonly evidence: readonly ArtistEraWindowEvidence[];
  readonly peak: ArtistEraPeak;
  readonly playCount: number;
  readonly share: number;
  readonly strength: number;
  readonly windowEndExclusive: string;
  readonly windowStart: string;
}

export interface ArtistEraResult extends JsonObject {
  readonly intervals: readonly ArtistEraInterval[];
}

export interface GenerateArtistEraAnalysisOptions {
  readonly connection: SqliteConnection;
  readonly parameters?: unknown;
  readonly presentationTimezone: string;
}

interface WindowKey {
  readonly month: number;
  readonly year: number;
}

interface ArtistWindow extends WindowKey {
  readonly artistDisplayName: string;
  readonly artistId: number;
  readonly components: ArtistEraWindowComponents;
}

/**
 * Calculates calendar-aligned artist-era windows from the canonical base, then groups adjacent
 * qualifying windows into explainable intervals. It never reads source rows directly, so a
 * reconciled multi-source event remains one play and insertion order cannot affect the result.
 */
export function generateArtistEraAnalysis(
  options: GenerateArtistEraAnalysisOptions,
): AnalyticalResult<ArtistEraResult> {
  const validated = validateAnalyticalParameters(
    ARTIST_ERA_PARAMETER_DEFINITION,
    options.parameters ?? {},
  );
  const parameters = validated.values;
  const events = queryCanonicalAnalyticalBase(options.connection, options.presentationTimezone);
  const windows = calculateArtistWindows(events, parameters);
  const intervals = assembleArtistEraIntervals(windows, parameters);
  const eventCount = events.length;
  const unresolvedCount = events.filter((event) => event.eventStatus === "unresolved").length;
  const spotifyAvailableEventCount = events.filter((event) => event.hasSpotifySource).length;
  const lastfmAvailableEventCount = events.filter((event) => event.hasLastfmSource).length;
  const dateRange = dateRangeForEvents(events);

  return createAnalyticalResult({
    analysis: "artist-eras",
    asOf: dateRange?.endExclusive ?? null,
    dateRange,
    definition:
      "Calendar-aligned artist eras are consecutive qualifying windows over every current and unresolved canonical track event. Qualification uses the documented rolling activity, listening-share, rank, consecutive-activity, and earlier-baseline components; intervals retain each qualifying window's components.",
    eventCount,
    includedSources: ["lastfm", "spotify"],
    metadataCoverage: {
      lastfmSource: coverage(lastfmAvailableEventCount, eventCount),
      spotifySource: coverage(spotifyAvailableEventCount, eventCount),
    },
    parameters,
    presentationTimezone: options.presentationTimezone,
    result: { intervals },
    unresolvedRate: eventCount === 0 ? 0 : unresolvedCount / eventCount,
    versions: {
      analysis: ARTIST_ERA_ANALYSIS_VERSION,
      identityRules: [IDENTITY_RESOLUTION_RULE_VERSION],
      parameterSchema: validated.schemaVersion,
      query: ARTIST_ERA_QUERY_VERSION,
      reconciliationRules: uniqueNonEmpty(
        events.map((event) => event.reconciliationRuleVersion),
        "canonical-event-v1",
      ),
    },
  });
}

function calculateArtistWindows(
  events: readonly CanonicalAnalyticalBaseEvent[],
  parameters: ArtistEraParameters,
): readonly ArtistWindow[] {
  if (events.length === 0) return [];
  const firstEvent = events[0];
  const lastEvent = events.at(-1);
  if (firstEvent === undefined || lastEvent === undefined)
    throw new Error("Artist-era events unexpectedly empty");
  const first = monthForCalendar(firstEvent.calendar.month);
  const last = monthForCalendar(lastEvent.calendar.month);
  if (first === undefined || last === undefined)
    throw new Error("Artist-era events unexpectedly empty");
  const windowKeys = windowRange(first, last, parameters.windowSizeMonths);
  const artistNames = new Map<number, string>();
  const playCounts = new Map<number, Map<number, number>>();
  for (const event of events) {
    artistNames.set(event.artistId, event.artistDisplayName);
    const eventMonth = monthForCalendar(event.calendar.month);
    if (eventMonth === undefined) throw new Error("Artist-era event has an invalid calendar month");
    const window = alignMonth(eventMonth, parameters.windowSizeMonths);
    const index = monthIndex(window);
    const artistCounts = playCounts.get(event.artistId) ?? new Map<number, number>();
    artistCounts.set(index, (artistCounts.get(index) ?? 0) + 1);
    playCounts.set(event.artistId, artistCounts);
  }

  const rollingByArtist = new Map<number, readonly number[]>();
  const currentByArtist = new Map<number, readonly number[]>();
  for (const [artistId, counts] of playCounts) {
    const current = windowKeys.map((key) => counts.get(monthIndex(key)) ?? 0);
    currentByArtist.set(artistId, current);
    rollingByArtist.set(
      artistId,
      current.map((_, index) =>
        current
          .slice(Math.max(0, index - parameters.rollingWindowCount + 1), index + 1)
          .reduce((sum, count) => sum + count, 0),
      ),
    );
  }

  const output: ArtistWindow[] = [];
  for (let index = 0; index < windowKeys.length; index += 1) {
    const rankByArtist = denseRanks(
      [...artistNames.keys()].map((artistId) => ({
        artistId,
        rollingPlayCount: rollingByArtist.get(artistId)?.[index] ?? 0,
      })),
    );
    const totalRollingPlayCount = [...artistNames.keys()].reduce(
      (sum, artistId) => sum + (rollingByArtist.get(artistId)?.[index] ?? 0),
      0,
    );
    for (const [artistId, artistDisplayName] of artistNames) {
      const current = currentByArtist.get(artistId);
      const rolling = rollingByArtist.get(artistId);
      if (current === undefined || rolling === undefined) continue;
      const consecutiveActiveWindows = consecutiveCount(current, rolling, index, parameters);
      const earlierBaselineEnd = index - parameters.rollingWindowCount;
      const earlierBaselineRollingPlayCount =
        earlierBaselineEnd - parameters.rollingWindowCount + 1 < 0
          ? null
          : current
              .slice(earlierBaselineEnd - parameters.rollingWindowCount + 1, earlierBaselineEnd + 1)
              .reduce((sum, count) => sum + count, 0);
      const key = windowKeys[index];
      if (key === undefined) throw new Error("Artist-era window unexpectedly missing");
      const rollingPlayCount = rolling[index] ?? 0;
      output.push({
        artistDisplayName,
        artistId,
        ...key,
        components: evaluateArtistEraWindow(
          {
            consecutiveActiveWindows,
            earlierBaselineRollingPlayCount,
            listeningShare:
              totalRollingPlayCount === 0 ? 0 : rollingPlayCount / totalRollingPlayCount,
            rank: rankByArtist.get(artistId) ?? 1,
            rollingPlayCount,
            windowPlayCount: current[index] ?? 0,
          },
          parameters,
        ),
      });
    }
  }
  return output;
}

function assembleArtistEraIntervals(
  windows: readonly ArtistWindow[],
  parameters: ArtistEraParameters,
): readonly ArtistEraInterval[] {
  const byArtist = new Map<number, ArtistWindow[]>();
  for (const window of windows) {
    const artistWindows = byArtist.get(window.artistId) ?? [];
    artistWindows.push(window);
    byArtist.set(window.artistId, artistWindows);
  }
  const intervals: ArtistEraInterval[] = [];
  for (const artistWindows of byArtist.values()) {
    let qualifying: ArtistWindow[] = [];
    for (const window of artistWindows) {
      if (window.components.isQualified) {
        qualifying.push(window);
      } else if (qualifying.length > 0) {
        intervals.push(createInterval(qualifying, parameters.windowSizeMonths));
        qualifying = [];
      }
    }
    if (qualifying.length > 0)
      intervals.push(createInterval(qualifying, parameters.windowSizeMonths));
  }
  return intervals.sort((left, right) =>
    left.windowStart === right.windowStart
      ? left.artistId - right.artistId
      : left.windowStart < right.windowStart
        ? -1
        : 1,
  );
}

function createInterval(
  qualifying: readonly ArtistWindow[],
  windowSizeMonths: number,
): ArtistEraInterval {
  const first = qualifying[0];
  const last = qualifying.at(-1);
  if (first === undefined || last === undefined)
    throw new Error("Artist-era interval unexpectedly empty");
  const evidence = qualifying.map((window) => ({
    components: window.components,
    windowEndExclusive: formatMonth(addMonths(window, windowSizeMonths)),
    windowStart: formatMonth(window),
  }));
  const peakWindow = qualifying.reduce((peak, window) => {
    if (window.components.strength !== peak.components.strength) {
      return window.components.strength > peak.components.strength ? window : peak;
    }
    if (window.components.rollingPlayCount !== peak.components.rollingPlayCount) {
      return window.components.rollingPlayCount > peak.components.rollingPlayCount ? window : peak;
    }
    return monthIndex(window) < monthIndex(peak) ? window : peak;
  });
  return {
    artistDisplayName: first.artistDisplayName,
    artistId: first.artistId,
    evidence,
    peak: { components: peakWindow.components, windowStart: formatMonth(peakWindow) },
    playCount: qualifying.reduce((sum, window) => sum + window.components.windowPlayCount, 0),
    share:
      qualifying.reduce((sum, window) => sum + window.components.listeningShare, 0) /
      qualifying.length,
    strength: peakWindow.components.strength,
    windowEndExclusive: formatMonth(addMonths(last, windowSizeMonths)),
    windowStart: formatMonth(first),
  };
}

function consecutiveCount(
  current: readonly number[],
  rolling: readonly number[],
  index: number,
  parameters: ArtistEraParameters,
): number {
  let count = 0;
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (
      (current[cursor] ?? 0) < parameters.minimumWindowPlayCount ||
      (rolling[cursor] ?? 0) < parameters.minimumRollingPlayCount
    )
      break;
    count += 1;
  }
  return count;
}

function denseRanks(
  values: readonly { readonly artistId: number; readonly rollingPlayCount: number }[],
): ReadonlyMap<number, number> {
  const ordered = [...values].sort(
    (left, right) =>
      right.rollingPlayCount - left.rollingPlayCount || left.artistId - right.artistId,
  );
  const ranks = new Map<number, number>();
  let rank = 0;
  let previous: number | undefined;
  for (const value of ordered) {
    if (value.rollingPlayCount !== previous) rank += 1;
    ranks.set(value.artistId, rank);
    previous = value.rollingPlayCount;
  }
  return ranks;
}

function dateRangeForEvents(events: readonly CanonicalAnalyticalBaseEvent[]) {
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined) return null;
  return {
    endExclusive: new Date(last.calendarInstantEpochMs + 1).toISOString(),
    startInclusive: new Date(first.calendarInstantEpochMs).toISOString(),
  };
}

function coverage(availableEventCount: number, totalEventCount: number) {
  return {
    availableEventCount,
    rate: totalEventCount === 0 ? 0 : availableEventCount / totalEventCount,
    totalEventCount,
  };
}

function uniqueNonEmpty(values: readonly string[], fallback: string): readonly string[] {
  const nonEmpty = values.filter((value) => value !== "");
  return nonEmpty.length === 0 ? [fallback] : [...new Set(nonEmpty)].sort();
}

function monthForCalendar(value: string): WindowKey | undefined {
  const match = /^(\d{4,})-(\d{2})$/u.exec(value);
  if (match === null) return undefined;
  return { month: Number(match[2]), year: Number(match[1]) };
}

function windowRange(first: WindowKey, last: WindowKey, size: number): readonly WindowKey[] {
  const output: WindowKey[] = [];
  for (
    let current = alignMonth(first, size);
    monthIndex(current) <= monthIndex(last);
    current = addMonths(current, size)
  ) {
    output.push(current);
  }
  return output;
}

function alignMonth(month: WindowKey, size: number): WindowKey {
  const offset = monthIndex(month) - monthIndex({ month: 1, year: 1970 });
  return addMonths({ month: 1, year: 1970 }, offset - positiveModulo(offset, size));
}

function addMonths(month: WindowKey, count: number): WindowKey {
  const index = monthIndex(month) + count;
  return { month: positiveModulo(index, 12) + 1, year: Math.floor(index / 12) };
}

function monthIndex(month: WindowKey): number {
  return month.year * 12 + month.month - 1;
}

function formatMonth(month: WindowKey): string {
  return `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}`;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
