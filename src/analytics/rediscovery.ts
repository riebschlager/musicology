import type { JsonObject } from "../cli/result.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { IDENTITY_RESOLUTION_RULE_VERSION } from "../identity/resolution.ts";
import { generateArtistEraAnalysis, type ArtistEraInterval } from "./artist-eras.ts";
import {
  projectAnalyticalCalendar,
  queryCanonicalAnalyticalBase,
  type CanonicalAnalyticalBaseEvent,
} from "./base.ts";
import {
  AnalyticalResultContractError,
  createAnalyticalResult,
  validateAnalyticalParameters,
  type AnalyticalParameterDefinition,
  type AnalyticalResult,
} from "./result.ts";

export const REDISCOVERY_ANALYSIS_VERSION = "rediscovery-v1";
export const REDISCOVERY_PARAMETER_SCHEMA_VERSION = "rediscovery-parameters-v1";
export const REDISCOVERY_QUERY_VERSION = "canonical-rediscovery-v1";

const DAY_MS = 86_400_000;

export const DEFAULT_REDISCOVERY_PARAMETERS = {
  absenceThresholdDays: 180,
  minimumPersistencePlayCount: 2,
  minimumPriorPlayCount: 5,
  minimumReturnPlayCount: 1,
  persistenceWindowDays: 90,
  returnWindowDays: 30,
  scope: "artist",
} as const;

export interface RediscoveryParameters extends JsonObject {
  readonly absenceThresholdDays: number;
  readonly minimumPersistencePlayCount: number;
  readonly minimumPriorPlayCount: number;
  readonly minimumReturnPlayCount: number;
  readonly persistenceWindowDays: number;
  readonly returnWindowDays: number;
  readonly scope: "artist" | "track";
}

export const REDISCOVERY_PARAMETER_DEFINITION: AnalyticalParameterDefinition<RediscoveryParameters> =
  {
    schemaVersion: REDISCOVERY_PARAMETER_SCHEMA_VERSION,
    validate(input: unknown): RediscoveryParameters {
      if (!isPlainObject(input)) {
        throw new AnalyticalResultContractError("Rediscovery parameters must be an object");
      }
      const allowed = new Set(Object.keys(DEFAULT_REDISCOVERY_PARAMETERS));
      if (Object.keys(input).some((key) => !allowed.has(key))) {
        throw new AnalyticalResultContractError(
          "Rediscovery parameters contain an unsupported field",
        );
      }
      const parameters = { ...DEFAULT_REDISCOVERY_PARAMETERS, ...input };
      for (const key of [
        "absenceThresholdDays",
        "returnWindowDays",
        "persistenceWindowDays",
        "minimumPriorPlayCount",
        "minimumReturnPlayCount",
        "minimumPersistencePlayCount",
      ] as const) {
        if (!isPositiveSafeInteger(parameters[key])) {
          throw new AnalyticalResultContractError(
            `Rediscovery ${key} must be a positive safe integer`,
          );
        }
      }
      if (parameters.absenceThresholdDays > 3_650) {
        throw new AnalyticalResultContractError(
          "Rediscovery absenceThresholdDays must not exceed 3650",
        );
      }
      if (parameters.returnWindowDays > 365 || parameters.persistenceWindowDays > 730) {
        throw new AnalyticalResultContractError(
          "Rediscovery observation windows exceed supported bounds",
        );
      }
      if (parameters.scope !== "artist" && parameters.scope !== "track") {
        throw new AnalyticalResultContractError("Rediscovery scope must be artist or track");
      }
      return parameters;
    },
  };

export interface RediscoveryRelatedEra extends JsonObject {
  readonly windowEndExclusive: string;
  readonly windowStart: string;
}

export interface RediscoveryRecord extends JsonObject {
  readonly classification: "one_off_return" | "return_beginning_new_era" | "sustained_rediscovery";
  readonly entityDisplayName: string;
  readonly entityId: number;
  readonly gapDays: number;
  readonly persistence: "not_persistent" | "open" | "persistent";
  readonly persistencePlayCount: number;
  readonly priorListenAt: string;
  readonly priorPlayCount: number;
  readonly relatedEra: RediscoveryRelatedEra | null;
  readonly returnIntensity: number;
  readonly returnStartedAt: string;
  readonly returnWindowComplete: boolean;
  readonly scope: "artist" | "track";
}

export interface RediscoveryResult extends JsonObject {
  readonly rediscoveries: readonly RediscoveryRecord[];
}

export interface GenerateRediscoveryAnalysisOptions {
  readonly connection: SqliteConnection;
  readonly parameters?: unknown;
  readonly presentationTimezone: string;
}

interface EntityEvent {
  readonly artistId: number;
  readonly displayName: string;
  readonly entityId: number;
  readonly epochMs: number;
  readonly month: string;
}

/**
 * Finds returns after a configurable exact UTC-day absence. The calculation is deliberately based
 * on canonical events only; source records are not emitted or used as duplicate observations.
 */
export function generateRediscoveryAnalysis(
  options: GenerateRediscoveryAnalysisOptions,
): AnalyticalResult<RediscoveryResult> {
  const validated = validateAnalyticalParameters(
    REDISCOVERY_PARAMETER_DEFINITION,
    options.parameters ?? {},
  );
  const parameters = validated.values;
  const events = queryCanonicalAnalyticalBase(options.connection, options.presentationTimezone);
  const eras = generateArtistEraAnalysis({
    connection: options.connection,
    presentationTimezone: options.presentationTimezone,
  }).result.intervals;
  const rediscoveries = findRediscoveries(events, eras, parameters, options.presentationTimezone);
  const eventCount = events.length;
  const unresolvedCount = events.filter((event) => event.eventStatus === "unresolved").length;
  const spotifyAvailableEventCount = events.filter((event) => event.hasSpotifySource).length;
  const lastfmAvailableEventCount = events.filter((event) => event.hasLastfmSource).length;
  const dateRange = dateRangeForEvents(events);

  return createAnalyticalResult({
    analysis: "rediscovery",
    asOf: dateRange?.endExclusive ?? null,
    dateRange,
    definition:
      "A rediscovery is a canonical artist or track return after the configured exact UTC-day absence threshold and sufficient prior activity. Return intensity is the number of entity plays in the return window; persistence is assessed in the following window and remains open when the canonical history has not yet observed it. A related artist era is reported when available.",
    eventCount,
    includedSources: ["lastfm", "spotify"],
    metadataCoverage: {
      lastfmSource: coverage(lastfmAvailableEventCount, eventCount),
      spotifySource: coverage(spotifyAvailableEventCount, eventCount),
    },
    parameters,
    presentationTimezone: options.presentationTimezone,
    result: { rediscoveries },
    unresolvedRate: eventCount === 0 ? 0 : unresolvedCount / eventCount,
    versions: {
      analysis: REDISCOVERY_ANALYSIS_VERSION,
      identityRules: [IDENTITY_RESOLUTION_RULE_VERSION],
      parameterSchema: validated.schemaVersion,
      query: REDISCOVERY_QUERY_VERSION,
      reconciliationRules: uniqueNonEmpty(
        events.map((event) => event.reconciliationRuleVersion),
        "canonical-event-v1",
      ),
    },
  });
}

function findRediscoveries(
  events: readonly CanonicalAnalyticalBaseEvent[],
  eras: readonly ArtistEraInterval[],
  parameters: RediscoveryParameters,
  presentationTimezone: string,
): readonly RediscoveryRecord[] {
  const observationEnd = events.at(-1)?.calendarInstantEpochMs;
  if (observationEnd === undefined) return [];
  const byEntity = new Map<number, EntityEvent[]>();
  for (const event of events) {
    const entity = toEntityEvent(event, parameters.scope);
    const entityEvents = byEntity.get(entity.entityId) ?? [];
    entityEvents.push(entity);
    byEntity.set(entity.entityId, entityEvents);
  }
  const erasByArtist = new Map<number, readonly ArtistEraInterval[]>();
  for (const era of eras) {
    erasByArtist.set(era.artistId, [...(erasByArtist.get(era.artistId) ?? []), era]);
  }
  const output: RediscoveryRecord[] = [];
  for (const entityEvents of byEntity.values()) {
    entityEvents.sort((left, right) => left.epochMs - right.epochMs);
    for (let index = 1; index < entityEvents.length; index += 1) {
      const prior = entityEvents[index - 1];
      const returned = entityEvents[index];
      if (prior === undefined || returned === undefined) continue;
      const gapMs = returned.epochMs - prior.epochMs;
      if (
        gapMs < parameters.absenceThresholdDays * DAY_MS ||
        index < parameters.minimumPriorPlayCount
      )
        continue;
      const returnEnd = returned.epochMs + parameters.returnWindowDays * DAY_MS;
      const persistenceEnd = returnEnd + parameters.persistenceWindowDays * DAY_MS;
      const returnIntensity = countEvents(entityEvents, returned.epochMs, returnEnd);
      if (returnIntensity < parameters.minimumReturnPlayCount) continue;
      const persistencePlayCount = countEvents(entityEvents, returnEnd, persistenceEnd);
      const returnWindowComplete = observationEnd >= returnEnd;
      const persistence =
        observationEnd < persistenceEnd
          ? "open"
          : persistencePlayCount >= parameters.minimumPersistencePlayCount
            ? "persistent"
            : "not_persistent";
      const relatedEra = relatedEraFor(
        erasByArtist.get(returned.artistId) ?? [],
        returned.month,
        projectAnalyticalCalendar(
          returned.epochMs +
            (parameters.returnWindowDays + parameters.persistenceWindowDays) * DAY_MS,
          presentationTimezone,
        ).month,
      );
      const classification =
        relatedEra !== null && relatedEra.windowStart >= returned.month
          ? "return_beginning_new_era"
          : persistence === "persistent"
            ? "sustained_rediscovery"
            : "one_off_return";
      output.push({
        classification,
        entityDisplayName: returned.displayName,
        entityId: returned.entityId,
        gapDays: gapMs / DAY_MS,
        persistence,
        persistencePlayCount,
        priorListenAt: new Date(prior.epochMs).toISOString(),
        priorPlayCount: index,
        relatedEra,
        returnIntensity,
        returnStartedAt: new Date(returned.epochMs).toISOString(),
        returnWindowComplete,
        scope: parameters.scope,
      });
    }
  }
  return output.sort(
    (left, right) =>
      left.returnStartedAt.localeCompare(right.returnStartedAt) || left.entityId - right.entityId,
  );
}

function toEntityEvent(
  event: CanonicalAnalyticalBaseEvent,
  scope: RediscoveryParameters["scope"],
): EntityEvent {
  return {
    artistId: event.artistId,
    displayName: scope === "artist" ? event.artistDisplayName : event.trackDisplayTitle,
    entityId: scope === "artist" ? event.artistId : event.trackId,
    epochMs: event.calendarInstantEpochMs,
    month: event.calendar.month,
  };
}

function countEvents(
  events: readonly EntityEvent[],
  startInclusive: number,
  endExclusive: number,
): number {
  return events.filter((event) => event.epochMs >= startInclusive && event.epochMs < endExclusive)
    .length;
}

function relatedEraFor(
  eras: readonly ArtistEraInterval[],
  month: string,
  latestStartMonth: string,
): RediscoveryRelatedEra | null {
  const era = eras.find(
    (candidate) =>
      (candidate.windowStart <= month && month < candidate.windowEndExclusive) ||
      (month <= candidate.windowStart && candidate.windowStart <= latestStartMonth),
  );
  return era === undefined
    ? null
    : { windowEndExclusive: era.windowEndExclusive, windowStart: era.windowStart };
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
