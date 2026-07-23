import type { JsonObject, JsonValue } from "../cli/result.ts";

/**
 * Schema for every P4 analytical result. A schema-version change is a public contract change,
 * not an implicit consequence of changing an individual analysis.
 */
export const ANALYTICAL_RESULT_SCHEMA_VERSION = "analytical-result-v1";

/**
 * These source and credential fields are excluded project-wide. Analytical payloads are a public
 * boundary, so accepting arbitrary JSON must not provide a route around the evidence projections.
 */
const EXCLUDED_ANALYTICAL_FIELD_NAMES = new Set([
  "access_token",
  "account_username",
  "api_key",
  "authorization",
  "country",
  "credential",
  "device",
  "device_id",
  "file_path",
  "filename",
  "input_path",
  "ip_addr",
  "ip_address",
  "password",
  "platform",
  "raw_payload",
  "raw_record",
  "raw_source_record",
  "relative_path",
  "secret",
  "source_file",
  "source_path",
  "source_record",
  "token",
  "user_agent",
  "username",
]);

export type AnalyticalSource = "lastfm" | "spotify";

export interface AnalyticalDateRange {
  readonly endExclusive: string;
  readonly startInclusive: string;
}

export interface MetadataCoverage {
  readonly availableEventCount: number;
  readonly rate: number;
  readonly totalEventCount: number;
}

export interface AnalyticalResultVersions {
  /** Version of the analytical definition and implementation. */
  readonly analysis: string;
  /** Version of the TypeScript parameter validator that accepted `parameters`. */
  readonly parameterSchema: string;
  /** Version of the inspectable SQL query or view used to obtain the result. */
  readonly query: string;
  /** Distinct identity-resolution rule versions represented in the result inputs. */
  readonly identityRules: readonly string[];
  /** Distinct canonical-event/reconciliation rule versions represented in the result inputs. */
  readonly reconciliationRules: readonly string[];
}

export interface AnalyticalResult<TData extends JsonValue = JsonValue> {
  readonly analysis: string;
  readonly asOf: string;
  readonly dateRange: AnalyticalDateRange;
  readonly definition: string;
  readonly eventCount: number;
  readonly includedSources: readonly AnalyticalSource[];
  readonly metadataCoverage: Readonly<Record<string, MetadataCoverage>>;
  readonly parameters: JsonObject;
  readonly presentationTimezone: string;
  readonly result: TData;
  readonly schemaVersion: typeof ANALYTICAL_RESULT_SCHEMA_VERSION;
  readonly unresolvedRate: number;
  readonly versions: AnalyticalResultVersions;
}

export type AnalyticalResultInput<TData extends JsonValue = JsonValue> = Omit<
  AnalyticalResult<TData>,
  "schemaVersion"
>;

export interface AnalyticalParameterDefinition<TParameters extends JsonObject> {
  readonly schemaVersion: string;
  readonly validate: (input: unknown) => TParameters;
}

export interface ValidatedAnalyticalParameters<TParameters extends JsonObject> {
  readonly schemaVersion: string;
  readonly values: TParameters;
}

export class AnalyticalResultContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticalResultContractError";
  }
}

/**
 * Parameter validators belong to their analysis. Recording their version in the result means
 * consumers can distinguish a changed default or validation policy from a data-only rerun.
 */
export function validateAnalyticalParameters<TParameters extends JsonObject>(
  definition: AnalyticalParameterDefinition<TParameters>,
  input: unknown,
): ValidatedAnalyticalParameters<TParameters> {
  assertPlainObject(definition, "Parameter definition");
  if (typeof definition.validate !== "function") {
    throw new AnalyticalResultContractError("Parameter definition must provide a validator");
  }
  validateVersion(definition.schemaVersion, "Parameter schema version");
  const values = definition.validate(input);
  assertJsonObject(values, "Validated parameters");
  return { schemaVersion: definition.schemaVersion, values };
}

/** Creates a validated, normalized result envelope suitable for deterministic serialization. */
export function createAnalyticalResult<TData extends JsonValue>(
  input: AnalyticalResultInput<TData>,
): AnalyticalResult<TData> {
  assertPlainObject(input, "Analytical result");
  validateRequiredText(input.analysis, "Analysis name");
  validateRequiredText(input.definition, "Definition");
  validateTimezone(input.presentationTimezone);
  validateTimestamp(input.asOf, "As-of date");
  validateDateRange(input.dateRange, input.asOf);
  validateCount(input.eventCount, "Event count");
  validateRate(input.unresolvedRate, "Unresolved rate");
  assertJsonObject(input.parameters, "Parameters");
  assertJsonValue(input.result, "Result");

  const includedSources = normalizeSources(input.includedSources);
  const metadataCoverage = normalizeMetadataCoverage(input.metadataCoverage, input.eventCount);
  const versions = normalizeVersions(input.versions);

  return {
    analysis: input.analysis,
    asOf: input.asOf,
    dateRange: {
      endExclusive: input.dateRange.endExclusive,
      startInclusive: input.dateRange.startInclusive,
    },
    definition: input.definition,
    eventCount: input.eventCount,
    includedSources,
    metadataCoverage,
    parameters: normalizeJsonObject(input.parameters),
    presentationTimezone: input.presentationTimezone,
    result: normalizeJsonValue(input.result) as TData,
    schemaVersion: ANALYTICAL_RESULT_SCHEMA_VERSION,
    unresolvedRate: input.unresolvedRate,
    versions,
  };
}

/** Serializes recursively sorted JSON keys so equal analytical values have equal bytes. */
export function serializeAnalyticalResult(result: AnalyticalResult): string {
  const { schemaVersion: _schemaVersion, ...input } = result;
  const normalized = createAnalyticalResult(input);
  return `${JSON.stringify(normalized)}\n`;
}

function normalizeSources(sources: unknown): readonly AnalyticalSource[] {
  if (!Array.isArray(sources)) {
    throw new AnalyticalResultContractError("Included sources must be an array");
  }
  if (sources.length === 0) {
    throw new AnalyticalResultContractError("Included sources must not be empty");
  }
  const unique = new Set<AnalyticalSource>();
  for (const source of sources) {
    if (source !== "lastfm" && source !== "spotify") {
      throw new AnalyticalResultContractError("Included sources must be lastfm or spotify");
    }
    unique.add(source);
  }
  return [...unique].sort();
}

function normalizeMetadataCoverage(
  coverage: unknown,
  eventCount: number,
): Readonly<Record<string, MetadataCoverage>> {
  assertPlainObject(coverage, "Metadata coverage");
  const normalized: Record<string, MetadataCoverage> = {};
  for (const key of Object.keys(coverage).sort()) {
    validateRequiredText(key, "Metadata coverage name");
    const item = coverage[key];
    assertPlainObject(item, `Metadata coverage ${key}`);
    const availableEventCount = item.availableEventCount;
    const totalEventCount = item.totalEventCount;
    const rate = item.rate;
    validateCount(availableEventCount, `Metadata coverage ${key} available event count`);
    validateCount(totalEventCount, `Metadata coverage ${key} total event count`);
    if (totalEventCount !== eventCount) {
      throw new AnalyticalResultContractError(
        `Metadata coverage ${key} total event count must equal result event count`,
      );
    }
    if (availableEventCount > totalEventCount) {
      throw new AnalyticalResultContractError(
        `Metadata coverage ${key} available event count must not exceed total event count`,
      );
    }
    validateRate(rate, `Metadata coverage ${key} rate`);
    const expectedRate = totalEventCount === 0 ? 0 : availableEventCount / totalEventCount;
    if (rate !== expectedRate) {
      throw new AnalyticalResultContractError(
        `Metadata coverage ${key} rate must equal available event count divided by total event count`,
      );
    }
    normalized[key] = {
      availableEventCount,
      rate,
      totalEventCount,
    };
  }
  return normalized;
}

function normalizeVersions(versions: unknown): AnalyticalResultVersions {
  assertPlainObject(versions, "Analytical versions");
  const analysis = versions.analysis;
  const parameterSchema = versions.parameterSchema;
  const query = versions.query;
  validateVersion(analysis, "Analysis version");
  validateVersion(parameterSchema, "Parameter schema version");
  validateVersion(query, "SQL query version");
  return {
    analysis,
    identityRules: normalizeVersionsList(versions.identityRules, "Identity rule versions"),
    parameterSchema,
    query,
    reconciliationRules: normalizeVersionsList(
      versions.reconciliationRules,
      "Reconciliation rule versions",
    ),
  };
}

function normalizeVersionsList(values: unknown, label: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new AnalyticalResultContractError(`${label} must be a non-empty array`);
  }
  const normalized: string[] = [];
  for (const value of values) {
    validateVersion(value, label);
    normalized.push(value);
  }
  return [...new Set(normalized)].sort();
}

function validateDateRange(range: unknown, asOf: unknown): void {
  assertPlainObject(range, "Date range");
  const startInclusive = range.startInclusive;
  const endExclusive = range.endExclusive;
  validateTimestamp(startInclusive, "Date range start");
  validateTimestamp(endExclusive, "Date range end");
  validateTimestamp(asOf, "As-of date");
  const start = Date.parse(startInclusive);
  const end = Date.parse(endExclusive);
  const asOfEpoch = Date.parse(asOf);
  if (start >= end) {
    throw new AnalyticalResultContractError("Date range end must be after date range start");
  }
  if (end > asOfEpoch) {
    throw new AnalyticalResultContractError("Date range end must not be after the as-of date");
  }
}

function validateTimezone(timezone: unknown): void {
  validateRequiredText(timezone, "Presentation timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new AnalyticalResultContractError(
      "Presentation timezone must name a valid IANA timezone",
    );
  }
}

function validateTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new AnalyticalResultContractError(`${label} must be a canonical UTC ISO timestamp`);
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
    throw new AnalyticalResultContractError(`${label} must be a valid canonical UTC ISO timestamp`);
  }
}

function validateCount(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AnalyticalResultContractError(`${label} must be a non-negative safe integer`);
  }
}

function validateRate(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new AnalyticalResultContractError(`${label} must be a number from 0 through 1`);
  }
}

function validateVersion(value: unknown, label: string): asserts value is string {
  validateRequiredText(value, label);
}

function validateRequiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || /\p{Cc}/u.test(value)) {
    throw new AnalyticalResultContractError(
      `${label} must be non-empty and contain no control characters`,
    );
  }
}

function assertJsonObject(value: unknown, label: string): asserts value is JsonObject {
  if (!isPlainJsonObject(value)) {
    throw new AnalyticalResultContractError(`${label} must be a JSON object`);
  }
  assertJsonValue(value as JsonValue, label);
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainJsonObject(value)) {
    throw new AnalyticalResultContractError(`${label} must be a plain JSON object`);
  }
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new AnalyticalResultContractError(`${label} must not contain non-finite numbers`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label);
    return;
  }
  if (typeof value === "object") {
    if (!isPlainJsonObject(value)) {
      throw new AnalyticalResultContractError(`${label} must contain only plain JSON objects`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (isExcludedAnalyticalFieldName(key)) {
        throw new AnalyticalResultContractError(
          `${label} must not contain excluded private fields`,
        );
      }
      assertJsonValue(item, label);
    }
    return;
  }
  throw new AnalyticalResultContractError(`${label} must be JSON-serializable`);
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isExcludedAnalyticalFieldName(fieldName: string): boolean {
  const snakeCaseName = fieldName
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[\s-]+/gu, "_")
    .toLowerCase();
  return EXCLUDED_ANALYTICAL_FIELD_NAMES.has(snakeCaseName);
}

function normalizeJsonObject(value: JsonObject): JsonObject {
  return normalizeJsonValue(value) as JsonObject;
}

function normalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareJsonKeys(left, right))
        .map(([key, item]) => [key, normalizeJsonValue(item)]),
    );
  }
  return value;
}

/** Uses UTF-16 code-unit order, which is independent of the host locale and ICU data. */
function compareJsonKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
