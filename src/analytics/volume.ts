import type { JsonObject } from "../cli/result.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { IDENTITY_RESOLUTION_RULE_VERSION } from "../identity/resolution.ts";
import {
  projectAnalyticalCalendar,
  queryCanonicalAnalyticalBase,
  type CalendarProjection,
} from "./base.ts";
import {
  AnalyticalResultContractError,
  createAnalyticalResult,
  validateAnalyticalParameters,
  type AnalyticalResult,
  type AnalyticalParameterDefinition,
} from "./result.ts";

export const VOLUME_ANALYSIS_VERSION = "listening-volume-v1";
export const VOLUME_PARAMETER_SCHEMA_VERSION = "listening-volume-parameters-v1";
export const VOLUME_QUERY_VERSION = "canonical-volume-v1";

export type VolumeGrain = "day" | "iso_week" | "month" | "quarter" | "year";
export type VolumeMetric = "play_count" | "play_count_at_least_ms" | "listened_ms";

export interface VolumeParameters extends JsonObject {
  readonly endExclusive: string | null;
  readonly grain: VolumeGrain;
  readonly includeUnresolved: boolean;
  readonly metric: VolumeMetric;
  readonly minimumDurationMs: number;
  readonly rollingWindowPeriods: number;
  readonly startInclusive: string | null;
}

export interface VolumeRow extends JsonObject {
  readonly period: string;
  readonly priorYearValue: number | null;
  readonly rollingValue: number;
  readonly value: number;
  readonly yearOverYearAbsoluteChange: number | null;
  readonly yearOverYearRate: number | null;
}

export interface VolumeResult extends JsonObject {
  readonly metricLabel: string;
  readonly rows: readonly VolumeRow[];
  readonly totalValue: number;
}

export const VOLUME_PARAMETER_DEFINITION: AnalyticalParameterDefinition<VolumeParameters> = {
  schemaVersion: VOLUME_PARAMETER_SCHEMA_VERSION,
  validate(input: unknown): VolumeParameters {
    if (!isPlainObject(input)) {
      throw new AnalyticalResultContractError("Volume parameters must be an object");
    }
    const allowed = new Set([
      "endExclusive",
      "grain",
      "includeUnresolved",
      "metric",
      "minimumDurationMs",
      "rollingWindowPeriods",
      "startInclusive",
    ]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw new AnalyticalResultContractError("Volume parameters contain an unsupported field");
      }
    }
    const startInclusive = optionalUtcTimestamp(input.startInclusive, "startInclusive");
    const endExclusive = optionalUtcTimestamp(input.endExclusive, "endExclusive");
    if ((startInclusive === null) !== (endExclusive === null)) {
      throw new AnalyticalResultContractError(
        "startInclusive and endExclusive must be provided together",
      );
    }
    if (
      startInclusive !== null &&
      endExclusive !== null &&
      Date.parse(startInclusive) >= Date.parse(endExclusive)
    ) {
      throw new AnalyticalResultContractError("endExclusive must be after startInclusive");
    }
    const grain = input.grain ?? "month";
    if (!isGrain(grain))
      throw new AnalyticalResultContractError(
        "grain must be day, iso_week, month, quarter, or year",
      );
    const metric = input.metric ?? "play_count";
    if (!isMetric(metric))
      throw new AnalyticalResultContractError("metric must name a supported volume metric");
    const includeUnresolved = input.includeUnresolved ?? true;
    if (typeof includeUnresolved !== "boolean") {
      throw new AnalyticalResultContractError("includeUnresolved must be a boolean");
    }
    const minimumDurationMs = input.minimumDurationMs ?? 30_000;
    if (!isPositiveSafeInteger(minimumDurationMs)) {
      throw new AnalyticalResultContractError("minimumDurationMs must be a positive safe integer");
    }
    const rollingWindowPeriods = input.rollingWindowPeriods ?? 1;
    if (!isPositiveSafeInteger(rollingWindowPeriods) || rollingWindowPeriods > 3_650) {
      throw new AnalyticalResultContractError(
        "rollingWindowPeriods must be a positive safe integer no greater than 3650",
      );
    }
    return {
      endExclusive,
      grain,
      includeUnresolved,
      metric,
      minimumDurationMs,
      rollingWindowPeriods,
      startInclusive,
    };
  },
};

export interface GenerateVolumeAnalysisOptions {
  readonly connection: SqliteConnection;
  readonly parameters?: unknown;
  readonly presentationTimezone: string;
}

/**
 * Groups canonical events from the P4-02 base query. It intentionally performs grouping after
 * source backing is aggregated, so a Spotify/Last.fm reconciliation contributes one event.
 */
export function generateVolumeAnalysis(
  options: GenerateVolumeAnalysisOptions,
): AnalyticalResult<VolumeResult> {
  const validated = validateAnalyticalParameters(
    VOLUME_PARAMETER_DEFINITION,
    options.parameters ?? {},
  );
  const parameters = validated.values;
  const allEvents = queryCanonicalAnalyticalBase(options.connection, options.presentationTimezone);
  const startEpoch =
    parameters.startInclusive === null ? null : Date.parse(parameters.startInclusive);
  const endEpoch = parameters.endExclusive === null ? null : Date.parse(parameters.endExclusive);
  const events = allEvents.filter(
    (event) =>
      (parameters.includeUnresolved || event.eventStatus !== "unresolved") &&
      (startEpoch === null || event.calendarInstantEpochMs >= startEpoch) &&
      (endEpoch === null || event.calendarInstantEpochMs < endEpoch),
  );
  const range = resolveRange(
    events,
    parameters,
    startEpoch,
    endEpoch,
    options.presentationTimezone,
  );
  const values = new Map<string, number>();
  for (const event of events) {
    const value = valueForEvent(event.spotifyDurationMs, parameters);
    if (value === null) continue;
    const period = calendarPeriod(event.calendar, parameters.grain);
    values.set(period, (values.get(period) ?? 0) + value);
  }
  const periods =
    range === null ? [] : periodRange(range.firstPeriod, range.lastPeriod, parameters.grain);
  const rows = periods.map((period, index) => {
    const value = values.get(period) ?? 0;
    const rollingValue = periods
      .slice(Math.max(0, index - parameters.rollingWindowPeriods + 1), index + 1)
      .reduce((sum, priorPeriod) => sum + (values.get(priorPeriod) ?? 0), 0);
    const priorYearPeriodKey = priorYearPeriod(period, parameters.grain);
    const priorYearValue =
      priorYearPeriodKey === null ? null : (values.get(priorYearPeriodKey) ?? null);
    return {
      period,
      priorYearValue,
      rollingValue,
      value,
      yearOverYearAbsoluteChange: priorYearValue === null ? null : value - priorYearValue,
      yearOverYearRate:
        priorYearValue === null || priorYearValue === 0
          ? null
          : (value - priorYearValue) / priorYearValue,
    };
  });
  const eventCount = events.length;
  const spotifyDurationAvailableEventCount = events.filter(
    (event) => event.spotifyDurationMs !== null,
  ).length;
  const unresolvedCount = events.filter((event) => event.eventStatus === "unresolved").length;
  return createAnalyticalResult({
    analysis: "listening-volume",
    asOf: range?.endExclusive ?? null,
    dateRange:
      range === null
        ? null
        : { endExclusive: range.endExclusive, startInclusive: range.startInclusive },
    definition: definitionForMetric(
      parameters.metric,
      parameters.minimumDurationMs,
      parameters.includeUnresolved,
    ),
    eventCount,
    includedSources: ["lastfm", "spotify"],
    metadataCoverage: {
      spotifyDuration: {
        availableEventCount: spotifyDurationAvailableEventCount,
        rate: eventCount === 0 ? 0 : spotifyDurationAvailableEventCount / eventCount,
        totalEventCount: eventCount,
      },
    },
    parameters,
    presentationTimezone: options.presentationTimezone,
    result: {
      metricLabel: metricLabel(parameters.metric, parameters.minimumDurationMs),
      rows,
      totalValue: rows.reduce((sum, row) => sum + row.value, 0),
    },
    unresolvedRate: eventCount === 0 ? 0 : unresolvedCount / eventCount,
    versions: {
      analysis: VOLUME_ANALYSIS_VERSION,
      identityRules: [IDENTITY_RESOLUTION_RULE_VERSION],
      parameterSchema: validated.schemaVersion,
      query: VOLUME_QUERY_VERSION,
      reconciliationRules: uniqueNonEmpty(
        events.map((event) => event.reconciliationRuleVersion),
        "canonical-event-v1",
      ),
    },
  });
}

function resolveRange(
  events: readonly {
    readonly calendar: CalendarProjection;
    readonly calendarInstantEpochMs: number;
  }[],
  parameters: VolumeParameters,
  startEpoch: number | null,
  endEpoch: number | null,
  presentationTimezone: string,
): {
  readonly endExclusive: string;
  readonly firstPeriod: string;
  readonly lastPeriod: string;
  readonly startInclusive: string;
} | null {
  if (startEpoch !== null && endEpoch !== null) {
    return {
      endExclusive: new Date(endEpoch).toISOString(),
      firstPeriod: calendarPeriod(
        projectAnalyticalCalendar(startEpoch, presentationTimezone),
        parameters.grain,
      ),
      lastPeriod: calendarPeriod(
        projectAnalyticalCalendar(endEpoch - 1, presentationTimezone),
        parameters.grain,
      ),
      startInclusive: new Date(startEpoch).toISOString(),
    };
  }
  if (events.length === 0) return null;
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined)
    throw new Error("Volume event range was unexpectedly empty");
  return {
    endExclusive: new Date(last.calendarInstantEpochMs + 1).toISOString(),
    firstPeriod: calendarPeriod(first.calendar, parameters.grain),
    lastPeriod: calendarPeriod(last.calendar, parameters.grain),
    startInclusive: new Date(first.calendarInstantEpochMs).toISOString(),
  };
}

function valueForEvent(
  spotifyDurationMs: number | null,
  parameters: VolumeParameters,
): number | null {
  if (parameters.metric === "play_count") return 1;
  if (spotifyDurationMs === null) return null;
  if (parameters.metric === "play_count_at_least_ms") {
    return spotifyDurationMs >= parameters.minimumDurationMs ? 1 : null;
  }
  return spotifyDurationMs;
}

function calendarPeriod(calendar: CalendarProjection, grain: VolumeGrain): string {
  switch (grain) {
    case "day":
      return calendar.day;
    case "iso_week":
      return calendar.isoWeek;
    case "month":
      return calendar.month;
    case "quarter":
      return calendar.quarter;
    case "year":
      return calendar.year;
  }
}

function periodRange(first: string, last: string, grain: VolumeGrain): readonly string[] {
  const periods: string[] = [];
  let current = first;
  while (current <= last) {
    periods.push(current);
    current = nextPeriod(current, grain);
  }
  return periods;
}

function nextPeriod(period: string, grain: VolumeGrain): string {
  if (grain === "day") return formatDate(addDays(parseDay(period), 1));
  if (grain === "iso_week") {
    const [yearText, weekText] = period.split("-W");
    const year = Number(yearText);
    const week = Number(weekText);
    const date = isoWeekMonday(year, week);
    date.setUTCDate(date.getUTCDate() + 7);
    return isoWeekLabel(date);
  }
  if (grain === "month") {
    const [yearText, monthText] = period.split("-");
    let year = Number(yearText);
    let month = Number(monthText) + 1;
    if (month === 13) {
      year += 1;
      month = 1;
    }
    return `${year}-${String(month).padStart(2, "0")}`;
  }
  if (grain === "quarter") {
    const [yearText, quarterText] = period.split("-Q");
    let year = Number(yearText);
    let quarter = Number(quarterText) + 1;
    if (quarter === 5) {
      year += 1;
      quarter = 1;
    }
    return `${year}-Q${quarter}`;
  }
  return String(Number(period) + 1);
}

function priorYearPeriod(period: string, grain: VolumeGrain): string | null {
  if (grain === "day") {
    const date = parseDay(period);
    const prior = new Date(
      Date.UTC(date.getUTCFullYear() - 1, date.getUTCMonth(), date.getUTCDate()),
    );
    return prior.getUTCMonth() === date.getUTCMonth() ? formatDate(prior) : null;
  }
  if (grain === "iso_week") return `${Number(period.slice(0, 4)) - 1}${period.slice(4)}`;
  if (grain === "month" || grain === "quarter")
    return `${Number(period.slice(0, 4)) - 1}${period.slice(4)}`;
  return String(Number(period) - 1);
}

function parseDay(period: string): Date {
  return new Date(`${period}T00:00:00.000Z`);
}
function addDays(date: Date, count: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + count);
  return copy;
}
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function isoWeekMonday(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const weekday = jan4.getUTCDay() || 7;
  jan4.setUTCDate(jan4.getUTCDate() - weekday + 1 + (week - 1) * 7);
  return jan4;
}
function isoWeekLabel(date: Date): string {
  const target = new Date(date);
  target.setUTCDate(target.getUTCDate() + 3);
  const year = target.getUTCFullYear();
  const monday = isoWeekMonday(year, 1);
  return `${year}-W${String(Math.floor((date.getTime() - monday.getTime()) / 604_800_000) + 1).padStart(2, "0")}`;
}
function uniqueNonEmpty(values: readonly string[], fallback: string): readonly string[] {
  const result = [...new Set(values)].sort();
  return result.length === 0 ? [fallback] : result;
}
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function isGrain(value: unknown): value is VolumeGrain {
  return (
    value === "day" ||
    value === "iso_week" ||
    value === "month" ||
    value === "quarter" ||
    value === "year"
  );
}
function isMetric(value: unknown): value is VolumeMetric {
  return value === "play_count" || value === "play_count_at_least_ms" || value === "listened_ms";
}
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function optionalUtcTimestamp(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || new Date(value).toISOString() !== value)
    throw new AnalyticalResultContractError(`${name} must be a canonical UTC timestamp`);
  return value;
}
function definitionForMetric(
  metric: VolumeMetric,
  minimumDurationMs: number,
  includeUnresolved: boolean,
): string {
  if (metric === "play_count")
    return `Counts every selected canonical track event once by the selected calendar grain; unresolved events are ${includeUnresolved ? "included" : "excluded"}.`;
  if (metric === "listened_ms")
    return "Sums Spotify-backed milliseconds once per canonical event; it is Spotify-only and does not estimate Last.fm-only duration.";
  return `Counts canonical events with Spotify-backed duration of at least ${minimumDurationMs} milliseconds; this optional thresholded metric excludes events without Spotify duration evidence.`;
}
function metricLabel(metric: VolumeMetric, minimumDurationMs: number): string {
  if (metric === "play_count") return "Play count (all canonical track events)";
  if (metric === "listened_ms") return "Listened milliseconds (Spotify-backed only)";
  return `Play count (Spotify-backed duration at least ${minimumDurationMs} ms)`;
}
