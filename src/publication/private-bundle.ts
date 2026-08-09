import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ABANDONMENT_PARAMETER_DEFINITION,
  type AbandonmentResult,
} from "../analytics/abandonment.ts";
import { ARTIST_ERA_PARAMETER_DEFINITION } from "../analytics/artist-era.ts";
import type { ArtistEraResult } from "../analytics/artist-eras.ts";
import { GENRE_ERA_PARAMETER_DEFINITION, type GenreEraResult } from "../analytics/genre-eras.ts";
import {
  REDISCOVERY_PARAMETER_DEFINITION,
  type RediscoveryResult,
} from "../analytics/rediscovery.ts";
import {
  ANALYTICAL_RESULT_SCHEMA_VERSION,
  createAnalyticalResult,
  validateAnalyticalParameters,
  type AnalyticalParameterDefinition,
  type AnalyticalResult,
} from "../analytics/result.ts";
import { VOLUME_PARAMETER_DEFINITION, type VolumeResult } from "../analytics/volume.ts";
import type { JsonObject } from "../cli/result.ts";
import {
  ANALYTICAL_EXPORT_ARTIFACT_SCHEMA_VERSION,
  ANALYTICAL_EXPORT_SCHEMA_VERSION,
  type AnalyticalExportArtifact,
  type AnalyticalExportArtifactName,
  type AnalyticalExportDatabaseState,
  type AnalyticalExportManifest,
} from "../exports/analytics.ts";
import { COVERAGE_REPORT_VERSION, type CoverageReport } from "../reporting/coverage.ts";

const PRIVATE_ARTIFACT_NAMES = [
  "abandonment",
  "artist-eras",
  "coverage",
  "genre-eras",
  "rediscovery",
  "volume",
] as const satisfies readonly AnalyticalExportArtifactName[];

const PRIVATE_ANALYSIS_CONTRACTS = {
  abandonment: [
    "abandonment",
    "abandonment-v1",
    "abandonment-parameters-v1",
    "canonical-abandonment-v1",
  ],
  "artist-eras": [
    "artist-eras",
    "artist-era-v1",
    "artist-era-parameters-v1",
    "canonical-artist-era-v1",
  ],
  "genre-eras": ["genre-eras", "genre-era-v2", "genre-era-parameters-v1", "canonical-genre-era-v2"],
  rediscovery: [
    "rediscovery",
    "rediscovery-v1",
    "rediscovery-parameters-v1",
    "canonical-rediscovery-v1",
  ],
  volume: [
    "listening-volume",
    "listening-volume-v1",
    "listening-volume-parameters-v1",
    "canonical-volume-v1",
  ],
} as const;

export interface LoadedPrivateAnalyticalBundle {
  readonly abandonment: AnalyticalResult<AbandonmentResult>;
  readonly artistEras: AnalyticalResult<ArtistEraResult>;
  readonly coverage: CoverageReport;
  readonly databaseState: AnalyticalExportDatabaseState;
  readonly genreEras: AnalyticalResult<GenreEraResult>;
  readonly manifest: AnalyticalExportManifest;
  readonly rediscovery: AnalyticalResult<RediscoveryResult>;
  readonly volume: AnalyticalResult<VolumeResult>;
}

export class PrivateBundleError extends Error {
  readonly code:
    | "incompatible_private_bundle"
    | "inconsistent_private_bundle"
    | "missing_private_bundle"
    | "stale_private_bundle";

  constructor(code: PrivateBundleError["code"], message: string) {
    super(message);
    this.name = "PrivateBundleError";
    this.code = code;
  }
}

/**
 * Loads the ignored analytical export after its state has been verified against the current
 * database by the existing export boundary. Errors identify only safe artifact categories.
 */
export function loadPrivateAnalyticalBundle(
  directory: string,
  expectedDatabaseState: AnalyticalExportDatabaseState,
): LoadedPrivateAnalyticalBundle {
  const manifestFile = path.join(directory, "manifest.json");
  if (!existsSync(manifestFile)) {
    throw new PrivateBundleError(
      "missing_private_bundle",
      "Private analytical manifest is missing",
    );
  }
  const manifest = parseManifest(readSafeFile(manifestFile, "manifest"));
  if (stableJson(manifest.databaseState) !== stableJson(expectedDatabaseState)) {
    throw new PrivateBundleError(
      "stale_private_bundle",
      "Private analytical bundle is stale for the verified database state",
    );
  }

  const artifacts = new Map<AnalyticalExportArtifactName, AnalyticalExportArtifact>();
  for (const name of PRIVATE_ARTIFACT_NAMES) {
    const descriptor = manifest.artifacts[name];
    const artifactFile = path.join(directory, descriptor.file);
    if (!existsSync(artifactFile)) {
      throw new PrivateBundleError(
        "missing_private_bundle",
        `Private analytical artifact ${name} is missing`,
      );
    }
    const bytes = readSafeFile(artifactFile, name);
    if (sha256(bytes) !== descriptor.sha256) {
      throw new PrivateBundleError(
        "incompatible_private_bundle",
        `Private analytical artifact ${name} failed its digest check`,
      );
    }
    artifacts.set(name, parseArtifact(bytes, name, manifest.databaseState));
  }

  const volume = analyticalData<VolumeResult>(artifacts, "volume");
  const artistEras = analyticalData<ArtistEraResult>(artifacts, "artist-eras");
  const rediscovery = analyticalData<RediscoveryResult>(artifacts, "rediscovery");
  const abandonment = analyticalData<AbandonmentResult>(artifacts, "abandonment");
  const genreEras = analyticalData<GenreEraResult>(artifacts, "genre-eras");
  const coverage = coverageData(artifacts);
  validateCompatibleAnalysis(volume, "volume");
  validateCompatibleAnalysis(artistEras, "artist-eras");
  validateCompatibleAnalysis(rediscovery, "rediscovery");
  validateCompatibleAnalysis(abandonment, "abandonment");
  validateCompatibleAnalysis(genreEras, "genre-eras");
  validateCommonContext([volume, artistEras, rediscovery, abandonment, genreEras], coverage);

  return {
    abandonment,
    artistEras,
    coverage,
    databaseState: manifest.databaseState,
    genreEras,
    manifest,
    rediscovery,
    volume,
  };
}

function parseManifest(text: string): AnalyticalExportManifest {
  const value = parseObject(text, "manifest");
  exactKeys(value, ["artifacts", "databaseState", "schemaVersion"], "manifest");
  if (value.schemaVersion !== ANALYTICAL_EXPORT_SCHEMA_VERSION) incompatible("manifest");
  const state = validateDatabaseState(value.databaseState);
  const descriptors = plainObject(value.artifacts, "manifest");
  exactKeys(descriptors, PRIVATE_ARTIFACT_NAMES, "manifest");
  for (const name of PRIVATE_ARTIFACT_NAMES) {
    const descriptor = plainObject(descriptors[name], "manifest");
    exactKeys(descriptor, ["file", "sha256"], "manifest");
    if (descriptor.file !== `${name}.json` || !isSha256(descriptor.sha256)) {
      incompatible("manifest");
    }
  }
  return {
    artifacts: descriptors,
    databaseState: state,
    schemaVersion: ANALYTICAL_EXPORT_SCHEMA_VERSION,
  } as unknown as AnalyticalExportManifest;
}

function parseArtifact(
  text: string,
  expectedName: AnalyticalExportArtifactName,
  expectedState: AnalyticalExportDatabaseState,
): AnalyticalExportArtifact {
  const value = parseObject(text, expectedName);
  exactKeys(value, ["artifact", "databaseState", "data", "schemaVersion"], expectedName);
  if (
    value.schemaVersion !== ANALYTICAL_EXPORT_ARTIFACT_SCHEMA_VERSION ||
    value.artifact !== expectedName ||
    stableJson(validateDatabaseState(value.databaseState)) !== stableJson(expectedState) ||
    !isPlainObject(value.data)
  ) {
    incompatible(expectedName);
  }
  return value as unknown as AnalyticalExportArtifact;
}

function validateCompatibleAnalysis(
  input: AnalyticalResult,
  artifact: Exclude<AnalyticalExportArtifactName, "coverage">,
): void {
  try {
    const object = input as unknown as Record<string, unknown>;
    exactKeys(
      object,
      [
        "analysis",
        "asOf",
        "dateRange",
        "definition",
        "eventCount",
        "includedSources",
        "metadataCoverage",
        "parameters",
        "presentationTimezone",
        "result",
        "schemaVersion",
        "unresolvedRate",
        "versions",
      ],
      artifact,
    );
    const [analysis, analysisVersion, parameterSchema, query] =
      PRIVATE_ANALYSIS_CONTRACTS[artifact];
    const versions = plainObject(object.versions, artifact);
    exactKeys(
      versions,
      ["analysis", "identityRules", "parameterSchema", "query", "reconciliationRules"],
      artifact,
    );
    if (
      object.schemaVersion !== ANALYTICAL_RESULT_SCHEMA_VERSION ||
      object.analysis !== analysis ||
      versions.analysis !== analysisVersion ||
      versions.parameterSchema !== parameterSchema ||
      versions.query !== query ||
      !isCanonicalTimestampOrNull(object.asOf) ||
      !isAnalyticalDateRangeOrNull(object.dateRange) ||
      !isNonNegativeInteger(object.eventCount) ||
      !isRate(object.unresolvedRate) ||
      !isTimezone(object.presentationTimezone) ||
      !isSourceList(object.includedSources) ||
      !isPlainObject(object.metadataCoverage) ||
      !isPlainObject(object.parameters) ||
      !isPlainObject(object.result)
    ) {
      incompatible(artifact);
    }
    const { schemaVersion: _schemaVersion, ...envelope } = object;
    const normalized = createAnalyticalResult(envelope as never);
    if (stableJson(normalized) !== stableJson(object)) incompatible(artifact);
    validatePrivateParameters(artifact, object.parameters);
    validatePrivateResult(artifact, object.result);
    if (artifact === "rediscovery") {
      const parameters = object.parameters as { readonly scope: unknown };
      const result = object.result as {
        readonly rediscoveries: readonly { readonly scope: unknown }[];
      };
      if (result.rediscoveries.some((record) => record.scope !== parameters.scope)) {
        incompatible(artifact);
      }
    }
  } catch {
    incompatible(artifact);
  }
}

function validatePrivateParameters(
  artifact: Exclude<AnalyticalExportArtifactName, "coverage">,
  input: unknown,
): void {
  const definition: AnalyticalParameterDefinition<JsonObject> =
    artifact === "abandonment"
      ? ABANDONMENT_PARAMETER_DEFINITION
      : artifact === "artist-eras"
        ? ARTIST_ERA_PARAMETER_DEFINITION
        : artifact === "genre-eras"
          ? GENRE_ERA_PARAMETER_DEFINITION
          : artifact === "rediscovery"
            ? REDISCOVERY_PARAMETER_DEFINITION
            : VOLUME_PARAMETER_DEFINITION;
  const validated = validateAnalyticalParameters(definition, input).values;
  if (stableJson(validated) !== stableJson(input)) incompatible(artifact);
}

function validatePrivateResult(
  artifact: Exclude<AnalyticalExportArtifactName, "coverage">,
  input: unknown,
): void {
  switch (artifact) {
    case "volume":
      validateVolumeResult(input, artifact);
      return;
    case "artist-eras":
      validateArtistEraResult(input, artifact);
      return;
    case "rediscovery":
      validateRediscoveryResult(input, artifact);
      return;
    case "abandonment":
      validateAbandonmentResult(input, artifact);
      return;
    case "genre-eras":
      validateGenreEraResult(input, artifact);
      return;
  }
}

function validateVolumeResult(input: unknown, label: string): void {
  const result = exactObject(input, ["metricLabel", "rows", "totalValue"], label);
  validateRequiredText(result.metricLabel, label);
  validateNonNegativeSafeNumber(result.totalValue, label);
  const rows = arrayValue(result.rows, label);
  let total = 0;
  for (const item of rows) {
    const row = exactObject(
      item,
      [
        "period",
        "priorYearValue",
        "rollingValue",
        "value",
        "yearOverYearAbsoluteChange",
        "yearOverYearRate",
      ],
      label,
    );
    validateRequiredText(row.period, label);
    validateNonNegativeSafeNumber(row.value, label);
    validateNonNegativeSafeNumber(row.rollingValue, label);
    validateNullableNonNegativeSafeNumber(row.priorYearValue, label);
    validateNullableFiniteNumber(row.yearOverYearAbsoluteChange, label);
    validateNullableFiniteNumber(row.yearOverYearRate, label);
    total += row.value as number;
  }
  if (total !== result.totalValue) incompatible(label);
}

function validateArtistEraResult(input: unknown, label: string): void {
  const result = exactObject(input, ["intervals"], label);
  for (const item of arrayValue(result.intervals, label)) {
    const interval = exactObject(
      item,
      [
        "artistDisplayName",
        "artistId",
        "evidence",
        "peak",
        "playCount",
        "share",
        "strength",
        "windowEndExclusive",
        "windowStart",
      ],
      label,
    );
    validateRequiredText(interval.artistDisplayName, label);
    validatePositiveInteger(interval.artistId, label);
    validateMonthRange(interval.windowStart, interval.windowEndExclusive, label);
    validateNonNegativeInteger(interval.playCount, label);
    validateRateValue(interval.share, label);
    validateRateValue(interval.strength, label);
    const peak = exactObject(interval.peak, ["components", "windowStart"], label);
    validateMonth(peak.windowStart, label);
    const peakComponents = validateArtistComponents(peak.components, label);
    const evidence = arrayValue(interval.evidence, label);
    if (evidence.length === 0) incompatible(label);
    let evidencePlayCount = 0;
    let peakFound = false;
    let priorStart: string | undefined;
    for (const evidenceItem of evidence) {
      const row = exactObject(
        evidenceItem,
        ["components", "windowEndExclusive", "windowStart"],
        label,
      );
      validateMonthRange(row.windowStart, row.windowEndExclusive, label);
      if (priorStart !== undefined && (row.windowStart as string) <= priorStart)
        incompatible(label);
      priorStart = row.windowStart as string;
      const components = validateArtistComponents(row.components, label);
      evidencePlayCount += components.windowPlayCount;
      if (row.windowStart === peak.windowStart) {
        peakFound = true;
        if (stableJson(components) !== stableJson(peakComponents)) incompatible(label);
      }
    }
    if (
      !peakFound ||
      evidencePlayCount !== interval.playCount ||
      peakComponents.strength !== interval.strength
    ) {
      incompatible(label);
    }
  }
}

function validateArtistComponents(
  input: unknown,
  label: string,
): { readonly strength: number; readonly windowPlayCount: number } {
  const value = exactObject(
    input,
    [
      "consecutiveActiveWindows",
      "earlierBaselineChange",
      "earlierBaselineRollingPlayCount",
      "isQualified",
      "listeningShare",
      "rank",
      "rollingPlayCount",
      "strength",
      "windowPlayCount",
    ],
    label,
  );
  validateNonNegativeInteger(value.consecutiveActiveWindows, label);
  validateNullableFiniteNumber(value.earlierBaselineChange, label);
  validateNullableNonNegativeSafeNumber(value.earlierBaselineRollingPlayCount, label);
  validateBoolean(value.isQualified, label);
  validateRateValue(value.listeningShare, label);
  validatePositiveInteger(value.rank, label);
  validateNonNegativeInteger(value.rollingPlayCount, label);
  validateRateValue(value.strength, label);
  validateNonNegativeInteger(value.windowPlayCount, label);
  return {
    strength: value.strength as number,
    windowPlayCount: value.windowPlayCount as number,
  };
}

function validateRediscoveryResult(input: unknown, label: string): void {
  const result = exactObject(input, ["rediscoveries"], label);
  for (const item of arrayValue(result.rediscoveries, label)) {
    const record = exactObject(
      item,
      [
        "classification",
        "entityDisplayName",
        "entityId",
        "gapDays",
        "persistence",
        "persistencePlayCount",
        "priorListenAt",
        "priorPlayCount",
        "relatedEra",
        "returnIntensity",
        "returnStartedAt",
        "returnWindowComplete",
        "scope",
      ],
      label,
    );
    if (
      record.classification !== "one_off_return" &&
      record.classification !== "return_beginning_new_era" &&
      record.classification !== "sustained_rediscovery"
    ) {
      incompatible(label);
    }
    if (
      record.persistence !== "not_persistent" &&
      record.persistence !== "open" &&
      record.persistence !== "persistent"
    ) {
      incompatible(label);
    }
    if (record.scope !== "artist" && record.scope !== "track") incompatible(label);
    validateRequiredText(record.entityDisplayName, label);
    validatePositiveInteger(record.entityId, label);
    validateNonNegativeInteger(record.gapDays, label);
    validateNonNegativeInteger(record.persistencePlayCount, label);
    validateCanonicalTimestamp(record.priorListenAt, label);
    validateNonNegativeInteger(record.priorPlayCount, label);
    validateNonNegativeInteger(record.returnIntensity, label);
    validateCanonicalTimestamp(record.returnStartedAt, label);
    if ((record.priorListenAt as string) >= (record.returnStartedAt as string)) incompatible(label);
    validateBoolean(record.returnWindowComplete, label);
    if (record.relatedEra !== null) {
      const era = exactObject(record.relatedEra, ["windowEndExclusive", "windowStart"], label);
      validateMonthRange(era.windowStart, era.windowEndExclusive, label);
    }
  }
}

function validateAbandonmentResult(input: unknown, label: string): void {
  const result = exactObject(input, ["artists"], label);
  for (const item of arrayValue(result.artists, label)) {
    const record = exactObject(
      item,
      [
        "activePeriodCount",
        "artistDisplayName",
        "artistId",
        "confidence",
        "formerCadencePlayCount",
        "formerCadencePlaysPer30Days",
        "historicalPlayCount",
        "lastActivePeriod",
        "lastListenAt",
        "observationDays",
        "status",
      ],
      label,
    );
    validateNonNegativeInteger(record.activePeriodCount, label);
    validateRequiredText(record.artistDisplayName, label);
    validatePositiveInteger(record.artistId, label);
    validateNonNegativeInteger(record.formerCadencePlayCount, label);
    validateNonNegativeSafeNumber(record.formerCadencePlaysPer30Days, label);
    validateNonNegativeInteger(record.historicalPlayCount, label);
    validateCanonicalTimestamp(record.lastListenAt, label);
    validateNonNegativeInteger(record.observationDays, label);
    if (record.status !== "dormant" && record.status !== "likely_abandoned_as_of") {
      incompatible(label);
    }
    const active = exactObject(record.lastActivePeriod, ["endAt", "playCount", "startAt"], label);
    validateCanonicalTimestamp(active.startAt, label);
    validateCanonicalTimestamp(active.endAt, label);
    validateNonNegativeInteger(active.playCount, label);
    if (
      (active.startAt as string) > (active.endAt as string) ||
      active.endAt !== record.lastListenAt
    ) {
      incompatible(label);
    }
    const confidence = exactObject(
      record.confidence,
      ["formerCadence", "historicalImportance", "observationCompleteness", "score"],
      label,
    );
    for (const value of Object.values(confidence)) validateRateValue(value, label);
    const expectedScore =
      ((confidence.formerCadence as number) +
        (confidence.historicalImportance as number) +
        (confidence.observationCompleteness as number)) /
      3;
    if (confidence.score !== expectedScore) incompatible(label);
  }
}

function validateGenreEraResult(input: unknown, label: string): void {
  const result = exactObject(
    input,
    [
      "contributionVersion",
      "coverage",
      "fetchAge",
      "intervals",
      "mode",
      "provider",
      "taxonomyVersion",
      "weightingLevel",
    ],
    label,
  );
  if (
    result.contributionVersion !== "genre-contribution-v2" ||
    (result.mode !== "raw" && result.mode !== "curated") ||
    result.provider !== "musicbrainz" ||
    result.weightingLevel !== "artist" ||
    (result.taxonomyVersion !== null && typeof result.taxonomyVersion !== "string") ||
    (result.mode === "raw" && result.taxonomyVersion !== null) ||
    (result.mode === "curated" && result.taxonomyVersion === null)
  ) {
    incompatible(label);
  }
  validateGenreCoverage(result.coverage, label);
  validateGenreFreshness(result.fetchAge, label);
  for (const item of arrayValue(result.intervals, label)) validateGenreInterval(item, label);
}

function validateGenreCoverage(input: unknown, label: string): void {
  const coverage = exactObject(input, ["missing", "total", "usable"], label);
  const missing = validateGenreCount(coverage.missing, label);
  const total = validateGenreCount(coverage.total, label);
  const usable = validateGenreCount(coverage.usable, label);
  if (
    missing.artistCount + usable.artistCount !== total.artistCount ||
    missing.eventCount + usable.eventCount !== total.eventCount
  ) {
    incompatible(label);
  }
}

function validateGenreFreshness(input: unknown, label: string): void {
  const freshness = exactObject(
    input,
    ["evaluatedAtEpochMs", "fresh", "refreshAgeMs", "stale"],
    label,
  );
  validateNonNegativeInteger(freshness.evaluatedAtEpochMs, label);
  validatePositiveInteger(freshness.refreshAgeMs, label);
  validateGenreCount(freshness.fresh, label);
  validateGenreCount(freshness.stale, label);
}

function validateGenreCount(
  input: unknown,
  label: string,
): { readonly artistCount: number; readonly eventCount: number } {
  const value = exactObject(input, ["artistCount", "eventCount"], label);
  validateNonNegativeInteger(value.artistCount, label);
  validateNonNegativeInteger(value.eventCount, label);
  return value as { readonly artistCount: number; readonly eventCount: number };
}

function validateGenreInterval(input: unknown, label: string): void {
  const interval = exactObject(
    input,
    [
      "contribution",
      "evidence",
      "genreId",
      "genreLabel",
      "peak",
      "share",
      "strength",
      "windowEndExclusive",
      "windowStart",
    ],
    label,
  );
  validateNonNegativeSafeNumber(interval.contribution, label);
  validateRequiredText(interval.genreId, label);
  validateRequiredText(interval.genreLabel, label);
  validateRateValue(interval.share, label);
  validateRateValue(interval.strength, label);
  validateMonthRange(interval.windowStart, interval.windowEndExclusive, label);
  const peak = exactObject(interval.peak, ["components", "windowStart"], label);
  validateMonth(peak.windowStart, label);
  validateGenreComponents(peak.components, label);
  for (const item of arrayValue(interval.evidence, label)) {
    const evidence = exactObject(item, ["components", "windowEndExclusive", "windowStart"], label);
    validateMonthRange(evidence.windowStart, evidence.windowEndExclusive, label);
    validateGenreComponents(evidence.components, label);
  }
}

function validateGenreComponents(input: unknown, label: string): void {
  const value = exactObject(
    input,
    [
      "consecutiveActiveWindows",
      "earlierBaselineChange",
      "earlierBaselineRollingContribution",
      "isQualified",
      "listeningShare",
      "rank",
      "rollingContribution",
      "strength",
      "windowContribution",
    ],
    label,
  );
  validateNonNegativeInteger(value.consecutiveActiveWindows, label);
  validateNullableFiniteNumber(value.earlierBaselineChange, label);
  validateNullableNonNegativeSafeNumber(value.earlierBaselineRollingContribution, label);
  validateBoolean(value.isQualified, label);
  validateRateValue(value.listeningShare, label);
  validatePositiveInteger(value.rank, label);
  validateNonNegativeSafeNumber(value.rollingContribution, label);
  validateRateValue(value.strength, label);
  validateNonNegativeSafeNumber(value.windowContribution, label);
}

function validateCommonContext(
  analyses: readonly AnalyticalResult[],
  coverage: CoverageReport,
): void {
  const first = analyses[0];
  if (first === undefined) inconsistent();
  const context = stableJson({
    asOf: first.asOf,
    dateRange: first.dateRange,
    eventCount: first.eventCount,
    includedSources: first.includedSources,
    presentationTimezone: first.presentationTimezone,
    unresolvedRate: first.unresolvedRate,
  });
  if (
    analyses.some(
      (analysis) =>
        stableJson({
          asOf: analysis.asOf,
          dateRange: analysis.dateRange,
          eventCount: analysis.eventCount,
          includedSources: analysis.includedSources,
          presentationTimezone: analysis.presentationTimezone,
          unresolvedRate: analysis.unresolvedRate,
        }) !== context,
    ) ||
    coverage.reportVersion !== COVERAGE_REPORT_VERSION ||
    coverage.timezone !== first.presentationTimezone ||
    coverage.canonical.eventCount !== first.eventCount ||
    coverage.totals.canonicalEvents !== first.eventCount
  ) {
    inconsistent();
  }
}

function coverageData(
  artifacts: ReadonlyMap<AnalyticalExportArtifactName, AnalyticalExportArtifact>,
): CoverageReport {
  const value = artifacts.get("coverage")?.data;
  const label = "coverage";
  const report = plainObject(value, label);
  const keys = [
    "canonical",
    "generatedAt",
    "inputFiles",
    "reportVersion",
    "semantics",
    "sources",
    "timezone",
    "totals",
    ...(report.archiveBaselineComparison === undefined ? [] : ["archiveBaselineComparison"]),
  ];
  exactKeys(report, keys, label);
  if (report.reportVersion !== COVERAGE_REPORT_VERSION || !isTimezone(report.timezone)) {
    incompatible(label);
  }
  validateCanonicalTimestamp(report.generatedAt, label);
  const semantics = exactObject(
    report.semantics,
    ["canonicalEventCountsIncluded", "countLayer", "longGapDefinition", "longGapThresholdDays"],
    label,
  );
  if (
    semantics.canonicalEventCountsIncluded !== true ||
    semantics.countLayer !== "source_evidence_occurrences"
  ) {
    incompatible(label);
  }
  validateRequiredText(semantics.longGapDefinition, label);
  validatePositiveInteger(semantics.longGapThresholdDays, label);

  for (const file of arrayValue(report.inputFiles, label)) {
    const inputFile = exactObject(file, ["sha256", "source"], label);
    if (
      (inputFile.source !== "lastfm" && inputFile.source !== "spotify") ||
      !isSha256(inputFile.sha256)
    ) {
      incompatible(label);
    }
  }

  const totals = validateCountObject(
    report.totals,
    ["accepted", "canonicalEvents", "evidenceOccurrences", "nonMusic", "rejected"],
    label,
  );
  if (totals.accepted !== totals.evidenceOccurrences) incompatible(label);
  const sources = arrayValue(report.sources, label);
  const sourceNames = new Set<string>();
  let evidenceOccurrences = 0;
  let rejected = 0;
  let nonMusic = 0;
  for (const item of sources) {
    const source = exactObject(
      item,
      [
        "byYear",
        "duplicates",
        "evidenceCount",
        "longGaps",
        "missingFields",
        "observedRange",
        "source",
        "totals",
      ],
      label,
    );
    if (
      (source.source !== "lastfm" && source.source !== "spotify") ||
      sourceNames.has(source.source)
    ) {
      incompatible(label);
    }
    sourceNames.add(source.source);
    validateNonNegativeInteger(source.evidenceCount, label);
    const sourceTotals = validateCountObject(
      source.totals,
      ["accepted", "nonMusic", "rejected"],
      label,
    );
    if (sourceTotals.accepted !== source.evidenceCount) incompatible(label);
    const duplicates = validateCountObject(
      source.duplicates,
      ["extraEvidenceCount", "groupCount"],
      label,
    );
    if (duplicates.extraEvidenceCount > (source.evidenceCount as number)) incompatible(label);
    let yearlyEvidence = 0;
    let priorYear = 0;
    for (const yearItem of arrayValue(source.byYear, label)) {
      const year = exactObject(yearItem, ["evidenceCount", "year"], label);
      validatePositiveInteger(year.year, label);
      validateNonNegativeInteger(year.evidenceCount, label);
      if ((year.year as number) <= priorYear) incompatible(label);
      priorYear = year.year as number;
      yearlyEvidence += year.evidenceCount as number;
    }
    if (yearlyEvidence !== source.evidenceCount) incompatible(label);
    if (source.observedRange === null) {
      if (source.evidenceCount !== 0) incompatible(label);
    } else {
      const range = exactObject(source.observedRange, ["firstObservedAt", "lastObservedAt"], label);
      validateCanonicalTimestamp(range.firstObservedAt, label);
      validateCanonicalTimestamp(range.lastObservedAt, label);
      if ((range.firstObservedAt as string) > (range.lastObservedAt as string)) incompatible(label);
    }
    for (const gapItem of arrayValue(source.longGaps, label)) {
      const gap = exactObject(gapItem, ["after", "before", "durationDays"], label);
      validateCanonicalTimestamp(gap.after, label);
      validateCanonicalTimestamp(gap.before, label);
      validateNonNegativeSafeNumber(gap.durationDays, label);
      if ((gap.after as string) >= (gap.before as string)) incompatible(label);
    }
    const expectedMissingFields = new Set(
      source.source === "spotify"
        ? ["albumName", "reasonStart", "reasonEnd", "skipped", "offline", "offlineAt"]
        : [
            "albumName",
            "artistMusicBrainzId",
            "releaseMusicBrainzId",
            "recordingMusicBrainzId",
            "loved",
          ],
    );
    const seenMissingFields = new Set<string>();
    for (const missingItem of arrayValue(source.missingFields, label)) {
      const missing = exactObject(
        missingItem,
        ["field", "missingCount", "missingRate", "totalCount"],
        label,
      );
      validateRequiredText(missing.field, label);
      if (
        !expectedMissingFields.has(missing.field as string) ||
        seenMissingFields.has(missing.field as string)
      ) {
        incompatible(label);
      }
      seenMissingFields.add(missing.field as string);
      validateNonNegativeInteger(missing.missingCount, label);
      validateNonNegativeInteger(missing.totalCount, label);
      validateRateValue(missing.missingRate, label);
      if (
        missing.totalCount !== source.evidenceCount ||
        (missing.missingCount as number) > (missing.totalCount as number) ||
        missing.missingRate !==
          (missing.totalCount === 0
            ? 0
            : (missing.missingCount as number) / (missing.totalCount as number))
      ) {
        incompatible(label);
      }
    }
    if (seenMissingFields.size !== expectedMissingFields.size) incompatible(label);
    evidenceOccurrences += source.evidenceCount as number;
    rejected += sourceTotals.rejected;
    nonMusic += sourceTotals.nonMusic;
  }
  if (
    sourceNames.size !== 2 ||
    !sourceNames.has("lastfm") ||
    !sourceNames.has("spotify") ||
    evidenceOccurrences !== totals.evidenceOccurrences ||
    rejected !== totals.rejected ||
    nonMusic !== totals.nonMusic
  ) {
    incompatible(label);
  }

  const canonical = exactObject(
    report.canonical,
    ["bySourceBacking", "eventCount", "merges", "overlapByYear", "unresolved"],
    label,
  );
  validateNonNegativeInteger(canonical.eventCount, label);
  if (canonical.eventCount !== totals.canonicalEvents) incompatible(label);
  const backing = validateCountObject(
    canonical.bySourceBacking,
    ["both", "lastfm", "spotify"],
    label,
  );
  if (backing.both + backing.lastfm + backing.spotify !== canonical.eventCount) {
    incompatible(label);
  }
  validateCountObject(
    canonical.merges,
    [
      "exactDuplicateEvents",
      "exactDuplicateSourceLinks",
      "inferredCrossSourceEvents",
      "inferredCrossSourceSourceLinks",
    ],
    label,
  );
  const unresolved = exactObject(canonical.unresolved, ["eventCount", "rate"], label);
  validateNonNegativeInteger(unresolved.eventCount, label);
  validateRateValue(unresolved.rate, label);
  if (
    (unresolved.eventCount as number) > (canonical.eventCount as number) ||
    unresolved.rate !==
      (canonical.eventCount === 0
        ? 0
        : (unresolved.eventCount as number) / (canonical.eventCount as number))
  ) {
    incompatible(label);
  }
  let overlapTotal = 0;
  let priorOverlapYear = 0;
  for (const overlapItem of arrayValue(canonical.overlapByYear, label)) {
    const overlap = exactObject(overlapItem, ["eventCount", "year"], label);
    validatePositiveInteger(overlap.year, label);
    validateNonNegativeInteger(overlap.eventCount, label);
    if ((overlap.year as number) <= priorOverlapYear) incompatible(label);
    priorOverlapYear = overlap.year as number;
    overlapTotal += overlap.eventCount as number;
  }
  if (overlapTotal !== backing.both) incompatible(label);

  if (report.archiveBaselineComparison !== undefined) {
    validateArchiveBaselineComparison(report.archiveBaselineComparison, label);
  }
  return report as unknown as CoverageReport;
}

function analyticalData<T extends JsonObject>(
  artifacts: ReadonlyMap<AnalyticalExportArtifactName, AnalyticalExportArtifact>,
  name: Exclude<AnalyticalExportArtifactName, "coverage">,
): AnalyticalResult<T> {
  const value = artifacts.get(name)?.data;
  if (!isPlainObject(value)) incompatible(name);
  return value as unknown as AnalyticalResult<T>;
}

function validateDatabaseState(value: unknown): AnalyticalExportDatabaseState {
  const state = plainObject(value, "manifest");
  exactKeys(
    state,
    ["canonicalSnapshotSha256", "genreEvidenceSnapshotSha256", "migrations"],
    "manifest",
  );
  if (
    !isSha256(state.canonicalSnapshotSha256) ||
    !isSha256(state.genreEvidenceSnapshotSha256) ||
    !Array.isArray(state.migrations)
  ) {
    incompatible("manifest");
  }
  for (const migration of state.migrations) {
    const item = plainObject(migration, "manifest");
    exactKeys(item, ["checksumSha256", "name", "version"], "manifest");
    if (
      !isSha256(item.checksumSha256) ||
      typeof item.name !== "string" ||
      !isNonNegativeInteger(item.version)
    ) {
      incompatible("manifest");
    }
  }
  return state as unknown as AnalyticalExportDatabaseState;
}

function readSafeFile(file: string, label: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new PrivateBundleError(
      "missing_private_bundle",
      `Private analytical ${label} could not be read`,
    );
  }
}

function parseObject(text: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return plainObject(value, label);
  } catch (error) {
    if (error instanceof PrivateBundleError) throw error;
    incompatible(label);
  }
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) incompatible(label);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    incompatible(label);
  }
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const object = plainObject(value, label);
  exactKeys(object, keys, label);
  return object;
}

function validateCountObject<const TKeys extends readonly string[]>(
  value: unknown,
  keys: TKeys,
  label: string,
): Record<TKeys[number], number> {
  const object = exactObject(value, keys, label);
  for (const key of keys) validateNonNegativeInteger(object[key], label);
  return object as Record<TKeys[number], number>;
}

function validateArchiveBaselineComparison(input: unknown, label: string): void {
  const comparison = exactObject(input, ["deviations", "matches", "version"], label);
  validateBoolean(comparison.matches, label);
  validateRequiredText(comparison.version, label);
  const deviations = arrayValue(comparison.deviations, label);
  if (comparison.matches !== (deviations.length === 0)) incompatible(label);
  for (const item of deviations) {
    const deviation = exactObject(item, ["actual", "expected", "metric"], label);
    validateRequiredText(deviation.metric, label);
    validateNonNegativeSafeNumber(deviation.actual, label);
    validateNonNegativeSafeNumber(deviation.expected, label);
  }
}

function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) incompatible(label);
  return value;
}

function validateRequiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || /\p{Cc}/u.test(value)) {
    incompatible(label);
  }
}

function validateBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") incompatible(label);
}

function validatePositiveInteger(value: unknown, label: string): asserts value is number {
  if (!isNonNegativeInteger(value) || value === 0) incompatible(label);
}

function validateNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!isNonNegativeInteger(value)) incompatible(label);
}

function validateNonNegativeSafeNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) incompatible(label);
}

function validateNullableNonNegativeSafeNumber(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null) validateNonNegativeSafeNumber(value, label);
}

function validateNullableFiniteNumber(
  value: unknown,
  label: string,
): asserts value is number | null {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) incompatible(label);
}

function validateRateValue(value: unknown, label: string): asserts value is number {
  if (!isRate(value)) incompatible(label);
}

function validateCanonicalTimestamp(value: unknown, label: string): asserts value is string {
  if (!isCanonicalTimestampOrNull(value) || value === null) incompatible(label);
}

function validateMonth(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value)) {
    incompatible(label);
  }
}

function validateMonthRange(start: unknown, end: unknown, label: string): void {
  validateMonth(start, label);
  validateMonth(end, label);
  if (start >= end) incompatible(label);
}

function incompatible(label: string): never {
  throw new PrivateBundleError(
    "incompatible_private_bundle",
    `Private analytical ${label} is incompatible with the publication adapter`,
  );
}

function inconsistent(): never {
  throw new PrivateBundleError(
    "inconsistent_private_bundle",
    "Private analytical artifacts do not describe one consistent snapshot",
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isCanonicalTimestampOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function isAnalyticalDateRangeOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainObject(value)) return false;
  const startInclusive = value.startInclusive;
  const endExclusive = value.endExclusive;
  return (
    isCanonicalTimestampOrNull(startInclusive) &&
    startInclusive !== null &&
    isCanonicalTimestampOrNull(endExclusive) &&
    endExclusive !== null &&
    startInclusive < endExclusive
  );
}

function isSourceList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((source) => source === "lastfm" || source === "spotify") &&
    new Set(value).size === value.length
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}
