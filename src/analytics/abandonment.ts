import type { JsonObject } from "../cli/result.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { IDENTITY_RESOLUTION_RULE_VERSION } from "../identity/resolution.ts";
import { queryCanonicalAnalyticalBase, type CanonicalAnalyticalBaseEvent } from "./base.ts";
import {
  AnalyticalResultContractError,
  createAnalyticalResult,
  validateAnalyticalParameters,
  type AnalyticalParameterDefinition,
  type AnalyticalResult,
} from "./result.ts";

export const ABANDONMENT_ANALYSIS_VERSION = "abandonment-v1";
export const ABANDONMENT_PARAMETER_SCHEMA_VERSION = "abandonment-parameters-v1";
export const ABANDONMENT_QUERY_VERSION = "canonical-abandonment-v1";

const DAY_MS = 86_400_000;

/** Conservative defaults: a label needs meaningful prior activity and a fully observed year. */
export const DEFAULT_ABANDONMENT_PARAMETERS = {
  activePeriodGapDays: 90,
  dormancyDays: 180,
  formerCadenceWindowDays: 180,
  likelyAbandonedDays: 365,
  minimumFormerCadencePlayCount: 3,
  minimumHistoricalPlayCount: 5,
  observationWindowDays: 365,
} as const;

export interface AbandonmentParameters extends JsonObject {
  readonly activePeriodGapDays: number;
  readonly asOf: string | null;
  readonly dormancyDays: number;
  readonly formerCadenceWindowDays: number;
  readonly likelyAbandonedDays: number;
  readonly minimumFormerCadencePlayCount: number;
  readonly minimumHistoricalPlayCount: number;
  readonly observationWindowDays: number;
}

export const ABANDONMENT_PARAMETER_DEFINITION: AnalyticalParameterDefinition<AbandonmentParameters> =
  {
    schemaVersion: ABANDONMENT_PARAMETER_SCHEMA_VERSION,
    validate(input: unknown): AbandonmentParameters {
      if (!isPlainObject(input))
        throw new AnalyticalResultContractError("Abandonment parameters must be an object");
      const allowed = new Set([...Object.keys(DEFAULT_ABANDONMENT_PARAMETERS), "asOf"]);
      if (Object.keys(input).some((key) => !allowed.has(key))) {
        throw new AnalyticalResultContractError(
          "Abandonment parameters contain an unsupported field",
        );
      }
      const parameters = { ...DEFAULT_ABANDONMENT_PARAMETERS, ...input };
      for (const key of Object.keys(
        DEFAULT_ABANDONMENT_PARAMETERS,
      ) as (keyof typeof DEFAULT_ABANDONMENT_PARAMETERS)[]) {
        if (!isPositiveSafeInteger(parameters[key])) {
          throw new AnalyticalResultContractError(
            `Abandonment ${key} must be a positive safe integer`,
          );
        }
      }
      if (
        parameters.activePeriodGapDays > 365 ||
        parameters.formerCadenceWindowDays > 3_650 ||
        parameters.observationWindowDays > 3_650
      ) {
        throw new AnalyticalResultContractError(
          "Abandonment observation windows exceed supported bounds",
        );
      }
      if (parameters.dormancyDays > parameters.likelyAbandonedDays) {
        throw new AnalyticalResultContractError(
          "Abandonment dormancyDays must not exceed likelyAbandonedDays",
        );
      }
      const asOfInput = input.asOf;
      if (asOfInput !== undefined && asOfInput !== null && typeof asOfInput !== "string") {
        throw new AnalyticalResultContractError(
          "Abandonment asOf must be a canonical UTC timestamp",
        );
      }
      const asOf = asOfInput ?? null;
      if (asOf !== null && !isCanonicalUtcTimestamp(asOf)) {
        throw new AnalyticalResultContractError(
          "Abandonment asOf must be a canonical UTC timestamp",
        );
      }
      return { ...parameters, asOf };
    },
  };

export interface ActivePeriodEvidence extends JsonObject {
  readonly endAt: string;
  readonly playCount: number;
  readonly startAt: string;
}

export interface AbandonmentConfidence extends JsonObject {
  readonly formerCadence: number;
  readonly historicalImportance: number;
  readonly observationCompleteness: number;
  readonly score: number;
}

export interface AbandonmentRecord extends JsonObject {
  readonly activePeriodCount: number;
  readonly artistDisplayName: string;
  readonly artistId: number;
  readonly confidence: AbandonmentConfidence;
  readonly formerCadencePlaysPer30Days: number;
  readonly formerCadencePlayCount: number;
  readonly historicalPlayCount: number;
  readonly lastActivePeriod: ActivePeriodEvidence;
  readonly lastListenAt: string;
  readonly observationDays: number;
  readonly status: "dormant" | "likely_abandoned_as_of";
}

export interface AbandonmentResult extends JsonObject {
  readonly artists: readonly AbandonmentRecord[];
}

export interface GenerateAbandonmentAnalysisOptions {
  readonly connection: SqliteConnection;
  readonly parameters?: unknown;
  readonly presentationTimezone: string;
}

interface ArtistEvent {
  readonly artistDisplayName: string;
  readonly artistId: number;
  readonly epochMs: number;
}

/**
 * Finds historically important artists whose last active period has remained absent within the
 * observable canonical history. This is deliberately an as-of conclusion, never a permanent label:
 * a later canonical listen removes the artist from a later result while prior as-of results remain
 * reproducible through their recorded parameter and result envelopes.
 */
export function generateAbandonmentAnalysis(
  options: GenerateAbandonmentAnalysisOptions,
): AnalyticalResult<AbandonmentResult> {
  const validated = validateAnalyticalParameters(
    ABANDONMENT_PARAMETER_DEFINITION,
    options.parameters ?? {},
  );
  const allEvents = queryCanonicalAnalyticalBase(options.connection, options.presentationTimezone);
  const requestedAsOfMs =
    validated.values.asOf === null ? undefined : Date.parse(validated.values.asOf);
  const latestEventMs = allEvents.at(-1)?.calendarInstantEpochMs;
  if (
    requestedAsOfMs !== undefined &&
    latestEventMs !== undefined &&
    requestedAsOfMs > latestEventMs
  ) {
    throw new AnalyticalResultContractError(
      "Abandonment asOf must not be later than the observed canonical history",
    );
  }
  const observationEnd = requestedAsOfMs ?? latestEventMs;
  const events =
    observationEnd === undefined
      ? []
      : allEvents.filter((event) => event.calendarInstantEpochMs <= observationEnd);
  const parameters = validated.values;
  const artists =
    observationEnd === undefined ? [] : findAbandonments(events, observationEnd, parameters);
  const eventCount = events.length;
  const unresolvedCount = events.filter((event) => event.eventStatus === "unresolved").length;
  const spotifyAvailableEventCount = events.filter((event) => event.hasSpotifySource).length;
  const lastfmAvailableEventCount = events.filter((event) => event.hasLastfmSource).length;
  const dateRange = dateRangeForEvents(events);

  return createAnalyticalResult({
    analysis: "abandonment",
    // The selected observation endpoint is inclusive, while the shared analytical range is
    // end-exclusive. Publish the range endpoint as the envelope as-of value so the complete
    // selected evidence interval is represented by the contract.
    asOf: dateRange?.endExclusive ?? null,
    dateRange,
    definition:
      "An abandonment result is an as-of observation, not a permanent fact. It includes historically important artists with sufficient former cadence whose final active period has been absent for the configured duration. A fully observed observation window permits likely_abandoned_as_of; shorter observed absence is reported only as dormant. A later canonical listen invalidates the artist in a later as-of result without changing previously generated historical results.",
    eventCount,
    includedSources: ["lastfm", "spotify"],
    metadataCoverage: {
      lastfmSource: coverage(lastfmAvailableEventCount, eventCount),
      spotifySource: coverage(spotifyAvailableEventCount, eventCount),
    },
    parameters,
    presentationTimezone: options.presentationTimezone,
    result: { artists },
    unresolvedRate: eventCount === 0 ? 0 : unresolvedCount / eventCount,
    versions: {
      analysis: ABANDONMENT_ANALYSIS_VERSION,
      identityRules: [IDENTITY_RESOLUTION_RULE_VERSION],
      parameterSchema: validated.schemaVersion,
      query: ABANDONMENT_QUERY_VERSION,
      reconciliationRules: uniqueNonEmpty(
        events.map((event) => event.reconciliationRuleVersion),
        "canonical-event-v1",
      ),
    },
  });
}

function findAbandonments(
  events: readonly CanonicalAnalyticalBaseEvent[],
  observationEnd: number,
  parameters: AbandonmentParameters,
): readonly AbandonmentRecord[] {
  const byArtist = new Map<number, ArtistEvent[]>();
  for (const event of events) {
    const artistEvents = byArtist.get(event.artistId) ?? [];
    artistEvents.push({
      artistDisplayName: event.artistDisplayName,
      artistId: event.artistId,
      epochMs: event.calendarInstantEpochMs,
    });
    byArtist.set(event.artistId, artistEvents);
  }
  const output: AbandonmentRecord[] = [];
  for (const artistEvents of byArtist.values()) {
    artistEvents.sort((left, right) => left.epochMs - right.epochMs);
    const last = artistEvents.at(-1);
    if (last === undefined || artistEvents.length < parameters.minimumHistoricalPlayCount) continue;
    const observationDays = (observationEnd - last.epochMs) / DAY_MS;
    if (observationDays < parameters.dormancyDays) continue;
    const cadenceStart = last.epochMs - parameters.formerCadenceWindowDays * DAY_MS;
    const formerCadencePlayCount = artistEvents.filter(
      (event) => event.epochMs >= cadenceStart,
    ).length;
    if (formerCadencePlayCount < parameters.minimumFormerCadencePlayCount) continue;
    const periods = activePeriods(artistEvents, parameters.activePeriodGapDays);
    const lastActivePeriod = periods.at(-1);
    if (lastActivePeriod === undefined)
      throw new Error("Abandonment artist unexpectedly has no active period");
    const confidence = confidenceFor(
      artistEvents.length,
      formerCadencePlayCount,
      observationDays,
      parameters,
    );
    output.push({
      activePeriodCount: periods.length,
      artistDisplayName: last.artistDisplayName,
      artistId: last.artistId,
      confidence,
      formerCadencePlaysPer30Days:
        (formerCadencePlayCount * 30) / parameters.formerCadenceWindowDays,
      formerCadencePlayCount,
      historicalPlayCount: artistEvents.length,
      lastActivePeriod,
      lastListenAt: new Date(last.epochMs).toISOString(),
      observationDays,
      status:
        observationDays >= parameters.likelyAbandonedDays &&
        observationDays >= parameters.observationWindowDays
          ? "likely_abandoned_as_of"
          : "dormant",
    });
  }
  return output.sort(
    (left, right) => right.observationDays - left.observationDays || left.artistId - right.artistId,
  );
}

function activePeriods(
  events: readonly ArtistEvent[],
  activePeriodGapDays: number,
): readonly ActivePeriodEvidence[] {
  const gapMs = activePeriodGapDays * DAY_MS;
  const periods: ActivePeriodEvidence[] = [];
  let start = events[0];
  let previous = events[0];
  let playCount = 0;
  for (const event of events) {
    if (start === undefined || previous === undefined)
      throw new Error("Abandonment artist unexpectedly has no events");
    if (event.epochMs - previous.epochMs > gapMs) {
      periods.push({
        endAt: new Date(previous.epochMs).toISOString(),
        playCount,
        startAt: new Date(start.epochMs).toISOString(),
      });
      start = event;
      playCount = 0;
    }
    playCount += 1;
    previous = event;
  }
  if (start !== undefined && previous !== undefined) {
    periods.push({
      endAt: new Date(previous.epochMs).toISOString(),
      playCount,
      startAt: new Date(start.epochMs).toISOString(),
    });
  }
  return periods;
}

function confidenceFor(
  historicalPlayCount: number,
  formerCadencePlayCount: number,
  observationDays: number,
  parameters: AbandonmentParameters,
): AbandonmentConfidence {
  const historicalImportance = cappedRatio(
    historicalPlayCount,
    parameters.minimumHistoricalPlayCount * 2,
  );
  const formerCadence = cappedRatio(
    formerCadencePlayCount,
    parameters.minimumFormerCadencePlayCount * 2,
  );
  const observationCompleteness = cappedRatio(observationDays, parameters.observationWindowDays);
  return {
    formerCadence,
    historicalImportance,
    observationCompleteness,
    score: (historicalImportance + formerCadence + observationCompleteness) / 3,
  };
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

function cappedRatio(value: number, denominator: number): number {
  return Math.min(value / denominator, 1);
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isCanonicalUtcTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && !Number.isNaN(Date.parse(value))
  );
}
