import type { JsonObject } from "../cli/result.ts";
import {
  AnalyticalResultContractError,
  validateAnalyticalParameters,
  type AnalyticalParameterDefinition,
} from "./result.ts";

/** Stable version of the P4-04 artist-era parameter contract. */
export const ARTIST_ERA_PARAMETER_SCHEMA_VERSION = "artist-era-parameters-v1";

/**
 * Defaults are intentionally conservative: an era needs sustained, non-trivial activity, but a
 * new artist is not penalized merely because an equally long earlier baseline does not exist.
 */
export const DEFAULT_ARTIST_ERA_PARAMETERS = {
  maximumRank: 20,
  minimumConsecutiveActiveWindows: 2,
  minimumEarlierBaselineChange: -12,
  minimumListeningShare: 0.02,
  minimumRollingPlayCount: 12,
  minimumWindowPlayCount: 3,
  rollingWindowCount: 4,
  windowSizeMonths: 3,
} as const;

export interface ArtistEraParameters extends JsonObject {
  readonly maximumRank: number;
  readonly minimumConsecutiveActiveWindows: number;
  readonly minimumEarlierBaselineChange: number;
  readonly minimumListeningShare: number;
  readonly minimumRollingPlayCount: number;
  readonly minimumWindowPlayCount: number;
  readonly rollingWindowCount: number;
  readonly windowSizeMonths: number;
}

/** A calendar month in the explicit presentation timezone supplied by P4-05. */
export interface ArtistEraCalendarMonth {
  readonly month: number;
  readonly year: number;
}

/** The population-derived values P4-05 supplies for one artist and calendar-aligned window. */
export interface ArtistEraWindowInput {
  readonly consecutiveActiveWindows: number;
  /** Null means the prior equal-length baseline is not observable; it is never imputed. */
  readonly earlierBaselineRollingPlayCount: number | null;
  readonly listeningShare: number;
  readonly rank: number;
  readonly rollingPlayCount: number;
  readonly windowPlayCount: number;
}

/** Explainable components retained by P4-05 for every qualifying (and near-qualifying) window. */
export interface ArtistEraWindowComponents extends JsonObject {
  readonly consecutiveActiveWindows: number;
  readonly earlierBaselineChange: number | null;
  readonly earlierBaselineRollingPlayCount: number | null;
  readonly isQualified: boolean;
  readonly listeningShare: number;
  readonly rank: number;
  readonly rollingPlayCount: number;
  /** A deterministic 0–1 summary of the known, normalized component scores. */
  readonly strength: number;
  readonly windowPlayCount: number;
}

export const ARTIST_ERA_PARAMETER_DEFINITION: AnalyticalParameterDefinition<ArtistEraParameters> = {
  schemaVersion: ARTIST_ERA_PARAMETER_SCHEMA_VERSION,
  validate(input: unknown): ArtistEraParameters {
    if (!isPlainObject(input)) {
      throw new AnalyticalResultContractError("Artist-era parameters must be an object");
    }
    const allowed = new Set(Object.keys(DEFAULT_ARTIST_ERA_PARAMETERS));
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw new AnalyticalResultContractError(
          "Artist-era parameters contain an unsupported field",
        );
      }
    }
    const parameters = { ...DEFAULT_ARTIST_ERA_PARAMETERS, ...input };
    for (const key of [
      "windowSizeMonths",
      "rollingWindowCount",
      "minimumRollingPlayCount",
      "minimumWindowPlayCount",
      "maximumRank",
      "minimumConsecutiveActiveWindows",
    ] as const) {
      if (!isPositiveSafeInteger(parameters[key])) {
        throw new AnalyticalResultContractError(
          `Artist-era ${key} must be a positive safe integer`,
        );
      }
    }
    if (parameters.windowSizeMonths > 12) {
      throw new AnalyticalResultContractError("Artist-era windowSizeMonths must not exceed 12");
    }
    if (parameters.rollingWindowCount > 24) {
      throw new AnalyticalResultContractError("Artist-era rollingWindowCount must not exceed 24");
    }
    if (parameters.maximumRank > 100_000) {
      throw new AnalyticalResultContractError("Artist-era maximumRank must not exceed 100000");
    }
    if (parameters.minimumConsecutiveActiveWindows > 100) {
      throw new AnalyticalResultContractError(
        "Artist-era minimumConsecutiveActiveWindows must not exceed 100",
      );
    }
    if (!isSafeInteger(parameters.minimumEarlierBaselineChange)) {
      throw new AnalyticalResultContractError(
        "Artist-era minimumEarlierBaselineChange must be a safe integer",
      );
    }
    if (
      typeof parameters.minimumListeningShare !== "number" ||
      !Number.isFinite(parameters.minimumListeningShare) ||
      parameters.minimumListeningShare <= 0 ||
      parameters.minimumListeningShare > 1
    ) {
      throw new AnalyticalResultContractError(
        "Artist-era minimumListeningShare must be greater than zero and no greater than one",
      );
    }
    return parameters;
  },
};

/** Validates and completes parameters without beginning the P4-05 interval analysis. */
export function validateArtistEraParameters(input: unknown): ArtistEraParameters {
  return validateAnalyticalParameters(ARTIST_ERA_PARAMETER_DEFINITION, input).values;
}

/**
 * Returns the start month of the fixed-size calendar window containing `input`.
 *
 * Every cadence is anchored at January 1970, so non-divisor sizes remain continuous and do not
 * gain a short, year-end window. P4-05 supplies the timezone conversion and aggregates events;
 * this function only fixes the reproducible month-boundary contract.
 */
export function alignArtistEraWindowStart(
  input: ArtistEraCalendarMonth,
  parameterInput: unknown = {},
): ArtistEraCalendarMonth {
  const parameters = validateArtistEraParameters(parameterInput);
  validateCalendarMonth(input);
  const monthsSinceAnchor = (input.year - 1970) * 12 + (input.month - 1);
  const startOffset =
    monthsSinceAnchor - positiveModulo(monthsSinceAnchor, parameters.windowSizeMonths);
  return {
    month: positiveModulo(startOffset, 12) + 1,
    year: 1970 + Math.floor(startOffset / 12),
  };
}

/**
 * Evaluates a single already-aggregated window. A missing earlier baseline remains null and does
 * not fail the baseline-change gate; P4-05 must retain that missingness as evidence rather than
 * treating it as zero activity.
 */
export function evaluateArtistEraWindow(
  input: ArtistEraWindowInput,
  parameterInput: unknown = {},
): ArtistEraWindowComponents {
  const parameters = validateArtistEraParameters(parameterInput);
  validateWindowInput(input);
  const earlierBaselineChange =
    input.earlierBaselineRollingPlayCount === null
      ? null
      : input.rollingPlayCount - input.earlierBaselineRollingPlayCount;
  const isQualified =
    input.windowPlayCount >= parameters.minimumWindowPlayCount &&
    input.rollingPlayCount >= parameters.minimumRollingPlayCount &&
    input.listeningShare >= parameters.minimumListeningShare &&
    input.rank <= parameters.maximumRank &&
    input.consecutiveActiveWindows >= parameters.minimumConsecutiveActiveWindows &&
    (earlierBaselineChange === null ||
      earlierBaselineChange >= parameters.minimumEarlierBaselineChange);

  const scores = [
    cappedRatio(input.windowPlayCount, parameters.minimumWindowPlayCount),
    cappedRatio(input.rollingPlayCount, parameters.minimumRollingPlayCount),
    cappedRatio(input.listeningShare, parameters.minimumListeningShare),
    cappedRatio(parameters.maximumRank + 1 - input.rank, parameters.maximumRank),
    cappedRatio(input.consecutiveActiveWindows, parameters.minimumConsecutiveActiveWindows),
    ...(earlierBaselineChange === null
      ? []
      : [
          cappedRatio(
            earlierBaselineChange - parameters.minimumEarlierBaselineChange,
            parameters.minimumRollingPlayCount,
          ),
        ]),
  ];
  return {
    consecutiveActiveWindows: input.consecutiveActiveWindows,
    earlierBaselineChange,
    earlierBaselineRollingPlayCount: input.earlierBaselineRollingPlayCount,
    isQualified,
    listeningShare: input.listeningShare,
    rank: input.rank,
    rollingPlayCount: input.rollingPlayCount,
    strength: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    windowPlayCount: input.windowPlayCount,
  };
}

function validateWindowInput(input: ArtistEraWindowInput): void {
  if (!isPlainObject(input))
    throw new AnalyticalResultContractError("Artist-era window must be an object");
  for (const key of ["windowPlayCount", "rollingPlayCount", "consecutiveActiveWindows"] as const) {
    if (!isNonNegativeSafeInteger(input[key])) {
      throw new AnalyticalResultContractError(
        `Artist-era window ${key} must be a non-negative safe integer`,
      );
    }
  }
  if (!isPositiveSafeInteger(input.rank)) {
    throw new AnalyticalResultContractError(
      "Artist-era window rank must be a positive safe integer",
    );
  }
  if (
    typeof input.listeningShare !== "number" ||
    !Number.isFinite(input.listeningShare) ||
    input.listeningShare < 0 ||
    input.listeningShare > 1
  ) {
    throw new AnalyticalResultContractError(
      "Artist-era window listeningShare must be between zero and one",
    );
  }
  if (
    input.earlierBaselineRollingPlayCount !== null &&
    !isNonNegativeSafeInteger(input.earlierBaselineRollingPlayCount)
  ) {
    throw new AnalyticalResultContractError(
      "Artist-era window earlierBaselineRollingPlayCount must be null or a non-negative safe integer",
    );
  }
}

function validateCalendarMonth(input: ArtistEraCalendarMonth): void {
  if (!isPlainObject(input)) {
    throw new AnalyticalResultContractError("Artist-era calendar month must be an object");
  }
  if (!isPositiveSafeInteger(input.year)) {
    throw new AnalyticalResultContractError(
      "Artist-era calendar year must be a positive safe integer",
    );
  }
  if (!isPositiveSafeInteger(input.month) || input.month > 12) {
    throw new AnalyticalResultContractError(
      "Artist-era calendar month must be between one and twelve",
    );
  }
}

function cappedRatio(value: number, denominator: number): number {
  return Math.max(0, Math.min(1, value / denominator));
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}
