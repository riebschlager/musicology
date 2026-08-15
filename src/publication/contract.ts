import {
  PUBLIC_SELECTION_POLICY,
  PUBLIC_SELECTION_POLICY_VERSION,
  assertPublicSlug,
  isPublicArtistEligible,
} from "./policy.ts";

export const PUBLIC_ARTIFACT_SCHEMA_VERSION = "public-artifact-v1";
export const PUBLIC_MANIFEST_SCHEMA_VERSION = "public-manifest-v1";
export const PUBLIC_REVIEW_REPORT_SCHEMA_VERSION = "public-review-report-v1";
export const PUBLIC_GENERATION_VERSION = "public-snapshot-generator-v1";
const DAY_MS = 86_400_000;
const DAY_COUNT_TOLERANCE = 1e-9;

export const PUBLIC_ARTIFACT_FILES = {
  artists: "artists.json",
  editorial: "editorial.json",
  "genre-lab": "genre-lab.json",
  history: "history.json",
  stories: "stories.json",
} as const;

export type PublicArtifactName = keyof typeof PUBLIC_ARTIFACT_FILES;
export type PublicSource = "lastfm" | "spotify";

const PUBLIC_ANALYTICAL_VERSION_CONTRACTS = {
  abandonment: {
    analysisVersion: "abandonment-v1",
    parameterSchemaVersion: "abandonment-parameters-v1",
    queryVersion: "canonical-abandonment-v1",
  },
  "artist-eras": {
    analysisVersion: "artist-era-v1",
    parameterSchemaVersion: "artist-era-parameters-v1",
    queryVersion: "canonical-artist-era-v1",
  },
  "genre-eras": {
    analysisVersion: "genre-era-v2",
    parameterSchemaVersion: "genre-era-parameters-v1",
    queryVersion: "canonical-genre-era-v2",
  },
  "listening-volume": {
    analysisVersion: "listening-volume-v1",
    parameterSchemaVersion: "listening-volume-parameters-v1",
    queryVersion: "canonical-volume-v1",
  },
  rediscovery: {
    analysisVersion: "rediscovery-v1",
    parameterSchemaVersion: "rediscovery-parameters-v1",
    queryVersion: "canonical-rediscovery-v1",
  },
} as const;

type PublicAnalysisName = keyof typeof PUBLIC_ANALYTICAL_VERSION_CONTRACTS;

const publicArtifactEnvelopeFields = [
  "schemaVersion",
  "artifact",
  "snapshotId",
  "generationVersion",
  "selectionPolicyVersion",
  "timezone",
  "asOfDate",
  "publicationDate",
  "coverage.canonicalEventCount",
  "coverage.dateRange.startPeriod",
  "coverage.dateRange.endPeriodExclusive",
  "coverage.includedSources[]",
  "coverage.spotifyDurationEventCount",
  "coverage.unresolvedRate",
  "analyticalVersions[].analysis",
  "analyticalVersions[].analysisVersion",
  "analyticalVersions[].parameterSchemaVersion",
  "analyticalVersions[].queryVersion",
] as const;

const artistComponentFields = [
  "consecutiveActiveWindows",
  "earlierBaselineChange",
  "earlierBaselineRollingPlayCount",
  "listeningShare",
  "rank",
  "rollingPlayCount",
  "strength",
  "windowPlayCount",
] as const;

const editorialContentFields = [
  "contentSchemaVersion",
  "slug",
  "publicationStatus",
  "title",
  "summary",
  "body[].heading",
  "body[].paragraphs[]",
  "order",
  "accessibilitySummary",
  "publicReferences[]",
] as const;

export const PUBLIC_ARTIFACT_FIELD_ALLOWLIST: Readonly<
  Record<PublicArtifactName, readonly string[]>
> = {
  history: [
    ...publicArtifactEnvelopeFields,
    "data.metric",
    "data.metricDefinition",
    "data.grain",
    "data.parameters.includeUnresolved",
    "data.parameters.rollingWindowPeriods",
    "data.totalPlayCount",
    "data.periods[].period",
    "data.periods[].playCount",
    "data.periods[].rollingPlayCount",
    "data.periods[].priorYearPlayCount",
    "data.periods[].yearOverYearAbsoluteChange",
    "data.periods[].yearOverYearRate",
    "data.sourceCoverage[].source",
    "data.sourceCoverage[].observedStartPeriod",
    "data.sourceCoverage[].observedEndPeriod",
    "data.sourceCoverage[].byYear[].period",
    "data.sourceCoverage[].byYear[].evidenceCount",
    "data.sourceCoverage[].longGaps[].afterPeriod",
    "data.sourceCoverage[].longGaps[].beforePeriod",
    "data.sourceCoverage[].longGaps[].durationDays",
    "data.canonicalSourceBacking.lastfm",
    "data.canonicalSourceBacking.spotify",
    "data.canonicalSourceBacking.both",
    "data.overlapByYear[].period",
    "data.overlapByYear[].eventCount",
  ],
  artists: [
    ...publicArtifactEnvelopeFields,
    "data.artists[].slug",
    "data.artists[].displayName",
    "data.parameters.maximumRank",
    "data.parameters.minimumConsecutiveActiveWindows",
    "data.parameters.minimumEarlierBaselineChange",
    "data.parameters.minimumListeningShare",
    "data.parameters.minimumRollingPlayCount",
    "data.parameters.minimumWindowPlayCount",
    "data.parameters.rollingWindowCount",
    "data.parameters.windowSizeMonths",
    "data.artists[].intervals[].startPeriod",
    "data.artists[].intervals[].endPeriodExclusive",
    "data.artists[].intervals[].playCount",
    "data.artists[].intervals[].share",
    "data.artists[].intervals[].strength",
    "data.artists[].intervals[].peak.period",
    ...artistComponentFields.map((field) => `data.artists[].intervals[].peak.components.${field}`),
    "data.artists[].intervals[].evidence[].period",
    ...artistComponentFields.map(
      (field) => `data.artists[].intervals[].evidence[].components.${field}`,
    ),
  ],
  editorial: [
    ...publicArtifactEnvelopeFields,
    ...editorialContentFields.map((field) => `data.annotations[].${field}`),
    "data.annotations[].route",
    "data.annotations[].period",
    ...editorialContentFields.map((field) => `data.featuredArtists[].${field}`),
    "data.featuredArtists[].artistSlug",
    "data.featuredArtists[].storySlugs[]",
  ],
  stories: [
    ...publicArtifactEnvelopeFields,
    ...editorialContentFields.map((field) => `data.stories[].${field}`),
    "data.stories[].kind",
    "data.stories[].artistSlug",
    "data.stories[].selectedTrack.artistDisplayName",
    "data.stories[].selectedTrack.slug",
    "data.stories[].selectedTrack.storySlug",
    "data.stories[].selectedTrack.trackDisplayName",
    "data.stories[].parameters.absenceThresholdDays",
    "data.stories[].parameters.minimumPersistencePlayCount",
    "data.stories[].parameters.minimumPriorPlayCount",
    "data.stories[].parameters.minimumReturnPlayCount",
    "data.stories[].parameters.persistenceWindowDays",
    "data.stories[].parameters.returnWindowDays",
    "data.stories[].parameters.scope",
    "data.stories[].parameters.activePeriodGapDays",
    "data.stories[].parameters.dormancyDays",
    "data.stories[].parameters.formerCadenceWindowDays",
    "data.stories[].parameters.likelyAbandonedDays",
    "data.stories[].parameters.minimumFormerCadencePlayCount",
    "data.stories[].parameters.minimumHistoricalPlayCount",
    "data.stories[].parameters.observationWindowDays",
    "data.stories[].evidence.classification",
    "data.stories[].evidence.gapDays",
    "data.stories[].evidence.persistence",
    "data.stories[].evidence.persistencePlayCount",
    "data.stories[].evidence.priorPeriod",
    "data.stories[].evidence.priorPlayCount",
    "data.stories[].evidence.relatedEra.startPeriod",
    "data.stories[].evidence.relatedEra.endPeriodExclusive",
    "data.stories[].evidence.returnIntensity",
    "data.stories[].evidence.returnPeriod",
    "data.stories[].evidence.returnWindowComplete",
    "data.stories[].evidence.status",
    "data.stories[].evidence.activePeriodCount",
    "data.stories[].evidence.formerCadencePlayCount",
    "data.stories[].evidence.formerCadencePlaysPer30Days",
    "data.stories[].evidence.historicalPlayCount",
    "data.stories[].evidence.lastActivePeriod.startPeriod",
    "data.stories[].evidence.lastActivePeriod.endPeriod",
    "data.stories[].evidence.lastActivePeriod.playCount",
    "data.stories[].evidence.lastListenPeriod",
    "data.stories[].evidence.observationDays",
    "data.stories[].evidence.confidence.formerCadence",
    "data.stories[].evidence.confidence.historicalImportance",
    "data.stories[].evidence.confidence.observationCompleteness",
    "data.stories[].evidence.confidence.score",
    "data.stories[].supersedesStorySlug",
  ],
  "genre-lab": [
    ...publicArtifactEnvelopeFields,
    "data.status",
    "data.provider",
    "data.mode",
    "data.taxonomyVersion",
    "data.weightingLevel",
    "data.contributionVersion",
    "data.parameters.maximumRank",
    "data.parameters.minimumConsecutiveActiveWindows",
    "data.parameters.minimumEarlierBaselineChange",
    "data.parameters.minimumListeningShare",
    "data.parameters.minimumRollingContribution",
    "data.parameters.minimumWindowContribution",
    "data.parameters.rollingWindowCount",
    "data.parameters.windowSizeMonths",
    "data.freshnessDate",
    "data.usableEventCoverage.availableEventCount",
    "data.usableEventCoverage.totalEventCount",
    "data.usableEventCoverage.rate",
    "data.coverageByYear[].period",
    "data.coverageByYear[].usableEventCount",
    "data.coverageByYear[].totalEventCount",
    "data.coverageByYear[].rate",
    "data.genres[].slug",
    "data.genres[].label",
    "data.genres[].intervals[].contribution",
    "data.genres[].intervals[].startPeriod",
    "data.genres[].intervals[].endPeriodExclusive",
    "data.genres[].intervals[].peakPeriod",
    "data.genres[].intervals[].share",
    "data.genres[].intervals[].strength",
  ],
};

export interface PublicCoverageSummary {
  readonly canonicalEventCount: number;
  readonly dateRange: { readonly endPeriodExclusive: string; readonly startPeriod: string } | null;
  readonly includedSources: readonly PublicSource[];
  readonly spotifyDurationEventCount: number;
  readonly unresolvedRate: number;
}

export interface PublicAnalyticalVersion {
  readonly analysis: string;
  readonly analysisVersion: string;
  readonly parameterSchemaVersion: string;
  readonly queryVersion: string;
}

export interface PublicArtifactEnvelope<TName extends PublicArtifactName, TData> {
  readonly analyticalVersions: readonly PublicAnalyticalVersion[];
  readonly artifact: TName;
  readonly asOfDate: string | null;
  readonly coverage: PublicCoverageSummary;
  readonly data: TData;
  readonly generationVersion: typeof PUBLIC_GENERATION_VERSION;
  readonly publicationDate: string | null;
  readonly schemaVersion: typeof PUBLIC_ARTIFACT_SCHEMA_VERSION;
  readonly selectionPolicyVersion: typeof PUBLIC_SELECTION_POLICY_VERSION;
  readonly snapshotId: string;
  readonly timezone: string;
}

export interface PublicManifestArtifactReference {
  readonly file: string;
  readonly sha256: string;
}

export interface PublicManifest {
  readonly analyticalVersions: readonly PublicAnalyticalVersion[];
  readonly approval: {
    readonly decidedOn: string;
    readonly decision: "approved";
    readonly reportSha256: string;
  } | null;
  readonly artifacts: {
    readonly artists: PublicManifestArtifactReference;
    readonly editorial: PublicManifestArtifactReference;
    readonly genreLab: PublicManifestArtifactReference | null;
    readonly history: PublicManifestArtifactReference;
    readonly stories: PublicManifestArtifactReference;
  };
  readonly asOfDate: string | null;
  readonly coverage: PublicCoverageSummary;
  readonly downloads: readonly [];
  readonly generationVersion: typeof PUBLIC_GENERATION_VERSION;
  readonly publicationDate: string | null;
  readonly publicationPolicy: {
    readonly artwork: "project_owned_or_licensed_only";
    readonly externalRequests: "same_origin_only";
    readonly fonts: "system_only";
    readonly visitorAnalytics: "none";
  };
  readonly reportSha256: string;
  readonly schemaVersion: typeof PUBLIC_MANIFEST_SCHEMA_VERSION;
  readonly selectionPolicyVersion: typeof PUBLIC_SELECTION_POLICY_VERSION;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly state: "approved" | "candidate";
  readonly supersedesSnapshotId: string | null;
  readonly timezone: string;
}

export interface PublicReviewReport {
  readonly analyticalVersions: readonly PublicAnalyticalVersion[];
  readonly artifactSummaries: readonly {
    readonly artifact: PublicArtifactName;
    readonly file: string;
    readonly fieldAllowlist: readonly string[];
    readonly publicSlugs: readonly string[];
    readonly recordCount: number;
    readonly sha256: string;
  }[];
  readonly asOfDate: string | null;
  readonly candidateManifestSha256: string;
  readonly changeSummary: {
    readonly addedPublicSlugs: readonly string[];
    readonly changedArtifacts: readonly PublicArtifactName[];
    readonly removedPublicSlugs: readonly string[];
    readonly selectionPolicyChanged: boolean;
  };
  readonly coverage: PublicCoverageSummary;
  readonly generatedOn: string;
  readonly previousSnapshotId: string | null;
  readonly schemaVersion: typeof PUBLIC_REVIEW_REPORT_SCHEMA_VERSION;
  readonly selectionPolicyVersion: typeof PUBLIC_SELECTION_POLICY_VERSION;
  readonly snapshotId: string;
}

export class PublicContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicContractError";
  }
}

export function validatePublicArtifact(
  input: unknown,
): PublicArtifactEnvelope<PublicArtifactName, unknown> {
  assertNoForbiddenFields(input, "Public artifact");
  const object = exactObject(input, "Public artifact", [
    "analyticalVersions",
    "artifact",
    "asOfDate",
    "coverage",
    "data",
    "generationVersion",
    "publicationDate",
    "schemaVersion",
    "selectionPolicyVersion",
    "snapshotId",
    "timezone",
  ]);
  expectEqual(object.schemaVersion, PUBLIC_ARTIFACT_SCHEMA_VERSION, "Artifact schema version");
  expectEqual(object.generationVersion, PUBLIC_GENERATION_VERSION, "Generation version");
  expectEqual(
    object.selectionPolicyVersion,
    PUBLIC_SELECTION_POLICY_VERSION,
    "Selection policy version",
  );
  validateSnapshotId(object.snapshotId);
  validateTimezone(object.timezone);
  validateDateOrNull(object.asOfDate, "Artifact as-of date");
  validateDateOrNull(object.publicationDate, "Artifact publication date");
  validateCoverage(object.coverage);
  validateArtifactDateContext(object.asOfDate, object.coverage);
  const analyticalVersionNames = validateAnalyticalVersions(object.analyticalVersions);

  const artifact = validateArtifactName(object.artifact);
  let requiredAnalyses: readonly PublicAnalysisName[] = [];
  switch (artifact) {
    case "history":
      validateHistoryData(object.data, object.coverage);
      requiredAnalyses = ["listening-volume"];
      break;
    case "artists":
      validateArtistsData(object.data);
      requiredAnalyses = ["artist-eras"];
      break;
    case "editorial":
      validateEditorialData(object.data);
      break;
    case "stories":
      requiredAnalyses = validateStoriesData(object.data, object.asOfDate);
      break;
    case "genre-lab":
      validateGenreLabData(object.data);
      requiredAnalyses = ["genre-eras"];
      break;
  }
  requireAnalyticalVersions(analyticalVersionNames, requiredAnalyses, `${artifact} artifact`);
  return input as PublicArtifactEnvelope<PublicArtifactName, unknown>;
}

export function validatePublicManifest(input: unknown): PublicManifest {
  assertNoForbiddenFields(input, "Public manifest");
  const object = exactObject(input, "Public manifest", [
    "analyticalVersions",
    "approval",
    "artifacts",
    "asOfDate",
    "coverage",
    "downloads",
    "generationVersion",
    "publicationDate",
    "publicationPolicy",
    "reportSha256",
    "schemaVersion",
    "selectionPolicyVersion",
    "snapshotId",
    "snapshotSha256",
    "state",
    "supersedesSnapshotId",
    "timezone",
  ]);
  expectEqual(object.schemaVersion, PUBLIC_MANIFEST_SCHEMA_VERSION, "Manifest schema version");
  expectEqual(object.generationVersion, PUBLIC_GENERATION_VERSION, "Generation version");
  expectEqual(
    object.selectionPolicyVersion,
    PUBLIC_SELECTION_POLICY_VERSION,
    "Selection policy version",
  );
  validateSnapshotId(object.snapshotId);
  validateTimezone(object.timezone);
  validateDateOrNull(object.asOfDate, "Manifest as-of date");
  validateDateOrNull(object.publicationDate, "Manifest publication date");
  validateCoverage(object.coverage);
  validateArtifactDateContext(object.asOfDate, object.coverage);
  const analyticalVersionNames = validateAnalyticalVersions(object.analyticalVersions);
  validateSha256(object.reportSha256, "Review report hash");
  validateSha256(object.snapshotSha256, "Snapshot hash");
  if (object.supersedesSnapshotId !== null) {
    validateSnapshotId(object.supersedesSnapshotId);
    if (object.supersedesSnapshotId === object.snapshotId) {
      throw new PublicContractError("A snapshot cannot supersede itself");
    }
  }

  const artifacts = exactObject(object.artifacts, "Manifest artifacts", [
    "artists",
    "editorial",
    "genreLab",
    "history",
    "stories",
  ]);
  validateManifestArtifact(artifacts.artists, "artists");
  validateManifestArtifact(artifacts.editorial, "editorial");
  if (artifacts.genreLab !== null) validateManifestArtifact(artifacts.genreLab, "genre-lab");
  validateManifestArtifact(artifacts.history, "history");
  validateManifestArtifact(artifacts.stories, "stories");
  requireAnalyticalVersions(
    analyticalVersionNames,
    artifacts.genreLab === null
      ? ["abandonment", "artist-eras", "listening-volume", "rediscovery"]
      : ["abandonment", "artist-eras", "genre-eras", "listening-volume", "rediscovery"],
    "Manifest",
  );

  if (!Array.isArray(object.downloads) || object.downloads.length !== 0) {
    throw new PublicContractError("Public downloads must be an empty array under policy v1");
  }
  const publicationPolicy = exactObject(object.publicationPolicy, "Publication policy", [
    "artwork",
    "externalRequests",
    "fonts",
    "visitorAnalytics",
  ]);
  expectEqual(publicationPolicy.artwork, "project_owned_or_licensed_only", "Artwork policy");
  expectEqual(publicationPolicy.externalRequests, "same_origin_only", "External request policy");
  expectEqual(publicationPolicy.fonts, "system_only", "Font policy");
  expectEqual(publicationPolicy.visitorAnalytics, "none", "Visitor analytics policy");

  if (object.state !== "candidate" && object.state !== "approved") {
    throw new PublicContractError("Manifest state must be candidate or approved");
  }
  if (object.state === "candidate") {
    if (object.publicationDate !== null || object.approval !== null) {
      throw new PublicContractError("A candidate must not contain approval or publication date");
    }
  } else {
    if (object.publicationDate === null || object.approval === null) {
      throw new PublicContractError("An approved snapshot requires approval and publication date");
    }
    validateApproval(object.approval, object.reportSha256);
  }
  return input as PublicManifest;
}

export function validatePublicReviewReport(input: unknown): PublicReviewReport {
  assertNoForbiddenFields(input, "Public review report");
  const object = exactObject(input, "Public review report", [
    "analyticalVersions",
    "artifactSummaries",
    "asOfDate",
    "candidateManifestSha256",
    "changeSummary",
    "coverage",
    "generatedOn",
    "previousSnapshotId",
    "schemaVersion",
    "selectionPolicyVersion",
    "snapshotId",
  ]);
  expectEqual(object.schemaVersion, PUBLIC_REVIEW_REPORT_SCHEMA_VERSION, "Review schema version");
  expectEqual(
    object.selectionPolicyVersion,
    PUBLIC_SELECTION_POLICY_VERSION,
    "Selection policy version",
  );
  validateSnapshotId(object.snapshotId);
  validateSha256(object.candidateManifestSha256, "Candidate manifest hash");
  validateDate(object.generatedOn, "Review generation date");
  validateDateOrNull(object.asOfDate, "Review as-of date");
  validateCoverage(object.coverage);
  validateArtifactDateContext(object.asOfDate, object.coverage);
  const analyticalVersionNames = validateAnalyticalVersions(object.analyticalVersions);
  if (object.previousSnapshotId !== null) validateSnapshotId(object.previousSnapshotId);

  const summaries = arrayValue(object.artifactSummaries, "Artifact summaries");
  const names = new Set<PublicArtifactName>();
  for (const item of summaries) {
    const summary = exactObject(item, "Artifact summary", [
      "artifact",
      "fieldAllowlist",
      "file",
      "publicSlugs",
      "recordCount",
      "sha256",
    ]);
    const artifact = validateArtifactName(summary.artifact);
    if (names.has(artifact))
      throw new PublicContractError(`Duplicate artifact summary: ${artifact}`);
    names.add(artifact);
    expectEqual(summary.file, PUBLIC_ARTIFACT_FILES[artifact], `${artifact} public filename`);
    validateSha256(summary.sha256, `${artifact} hash`);
    validateCount(summary.recordCount, `${artifact} record count`);
    validateExactStringList(
      summary.fieldAllowlist,
      PUBLIC_ARTIFACT_FIELD_ALLOWLIST[artifact],
      `${artifact} field allowlist`,
    );
    validateSlugList(summary.publicSlugs, `${artifact} public slugs`);
  }
  for (const required of ["history", "artists", "editorial", "stories"] as const) {
    if (!names.has(required))
      throw new PublicContractError(`Missing required review summary: ${required}`);
  }
  requireAnalyticalVersions(
    analyticalVersionNames,
    names.has("genre-lab")
      ? ["abandonment", "artist-eras", "genre-eras", "listening-volume", "rediscovery"]
      : ["abandonment", "artist-eras", "listening-volume", "rediscovery"],
    "Review report",
  );

  const changes = exactObject(object.changeSummary, "Change summary", [
    "addedPublicSlugs",
    "changedArtifacts",
    "removedPublicSlugs",
    "selectionPolicyChanged",
  ]);
  validateSlugList(changes.addedPublicSlugs, "Added public slugs");
  validateSlugList(changes.removedPublicSlugs, "Removed public slugs");
  const changedArtifacts = arrayValue(changes.changedArtifacts, "Changed artifacts");
  let previousChangedArtifact: string | undefined;
  for (const artifact of changedArtifacts) {
    const name = validateArtifactName(artifact);
    assertStrictlyIncreasing(name, previousChangedArtifact, "Changed artifacts");
    previousChangedArtifact = name;
  }
  if (typeof changes.selectionPolicyChanged !== "boolean") {
    throw new PublicContractError("Selection policy changed must be boolean");
  }
  return input as PublicReviewReport;
}

function validateHistoryData(input: unknown, coverageInput: unknown): void {
  const object = exactObject(input, "History data", [
    "canonicalSourceBacking",
    "grain",
    "metric",
    "metricDefinition",
    "overlapByYear",
    "parameters",
    "periods",
    "sourceCoverage",
    "totalPlayCount",
  ]);
  const coverage = exactObject(coverageInput, "Public coverage", [
    "canonicalEventCount",
    "dateRange",
    "includedSources",
    "spotifyDurationEventCount",
    "unresolvedRate",
  ]);
  expectEqual(object.metric, "play_count", "History metric");
  expectEqual(object.grain, "month", "History grain");
  validateRequiredText(object.metricDefinition, "History metric definition");
  validateCount(object.totalPlayCount, "History total play count");
  const parameters = exactObject(object.parameters, "History parameters", [
    "includeUnresolved",
    "rollingWindowPeriods",
  ]);
  validateBoolean(parameters.includeUnresolved, "History include-unresolved parameter");
  validatePositiveCount(parameters.rollingWindowPeriods, "History rolling-window periods");
  if ((parameters.rollingWindowPeriods as number) > 3_650) {
    throw new PublicContractError("History rolling-window periods exceed the supported bound");
  }
  const periods = boundedArray(
    object.periods,
    PUBLIC_SELECTION_POLICY.resultLimits.maximumHistoryMonths,
    "History periods",
  );
  let total = 0;
  let previousPeriod: string | undefined;
  const coverageRange =
    coverage.dateRange === null ? null : (coverage.dateRange as Record<string, unknown>);
  for (const item of periods) {
    const row = exactObject(item, "History period", [
      "period",
      "playCount",
      "priorYearPlayCount",
      "rollingPlayCount",
      "yearOverYearAbsoluteChange",
      "yearOverYearRate",
    ]);
    validateMonth(row.period, "History period");
    validateCount(row.playCount, "History play count");
    validateCount(row.rollingPlayCount, "History rolling play count");
    validateNullableCount(row.priorYearPlayCount, "History prior-year play count");
    validateNullableSafeNumber(
      row.yearOverYearAbsoluteChange,
      "History year-over-year absolute change",
    );
    validateNullableSafeNumber(row.yearOverYearRate, "History year-over-year rate");
    assertStrictlyIncreasing(row.period as string, previousPeriod, "History periods");
    if (
      coverageRange === null ||
      (row.period as string) < (coverageRange.startPeriod as string) ||
      (row.period as string) >= (coverageRange.endPeriodExclusive as string)
    ) {
      throw new PublicContractError("History period must fall within public coverage");
    }
    previousPeriod = row.period as string;
    total += row.playCount;
  }
  if (total !== object.totalPlayCount) {
    throw new PublicContractError("History total play count must equal the period sum");
  }
  if (object.totalPlayCount !== coverage.canonicalEventCount) {
    throw new PublicContractError("History total play count must equal public canonical coverage");
  }
  if (coverage.canonicalEventCount === 0 && periods.length !== 0) {
    throw new PublicContractError("Empty public history must not fabricate period rows");
  }
  validateSourceCoverage(object.sourceCoverage, coverage.includedSources);
  const backing = validateCountObject(object.canonicalSourceBacking, "Canonical source backing", [
    "both",
    "lastfm",
    "spotify",
  ]);
  if (backing.both + backing.lastfm + backing.spotify !== coverage.canonicalEventCount) {
    throw new PublicContractError("Canonical source backing must equal public canonical coverage");
  }
  let overlapTotal = 0;
  let previousOverlapYear: string | undefined;
  for (const item of arrayValue(object.overlapByYear, "Overlap by year")) {
    const row = exactObject(item, "Overlap year", ["eventCount", "period"]);
    validateYear(row.period, "Overlap period");
    validateCount(row.eventCount, "Overlap event count");
    assertStrictlyIncreasing(row.period as string, previousOverlapYear, "Overlap years");
    previousOverlapYear = row.period as string;
    overlapTotal += row.eventCount;
  }
  if (overlapTotal !== backing.both) {
    throw new PublicContractError("Yearly overlap must equal canonical both-source backing");
  }
}

function validateSourceCoverage(input: unknown, includedSourcesInput: unknown): void {
  const sources = arrayValue(input, "Source coverage");
  const includedSources = new Set(
    arrayValue(includedSourcesInput, "Included sources").map((source) => validateSource(source)),
  );
  const seen = new Set<PublicSource>();
  let previousSourceName: string | undefined;
  for (const item of sources) {
    const source = exactObject(item, "Source coverage item", [
      "byYear",
      "longGaps",
      "observedEndPeriod",
      "observedStartPeriod",
      "source",
    ]);
    const sourceName = validateSource(source.source);
    if (seen.has(sourceName))
      throw new PublicContractError(`Duplicate source coverage: ${sourceName}`);
    assertStrictlyIncreasing(sourceName, previousSourceName, "Source coverage");
    previousSourceName = sourceName;
    seen.add(sourceName);
    validateNullableMonth(source.observedStartPeriod, "Source observed start period");
    validateNullableMonth(source.observedEndPeriod, "Source observed end period");
    if ((source.observedStartPeriod === null) !== (source.observedEndPeriod === null)) {
      throw new PublicContractError("Source observed range must be wholly known or wholly unknown");
    }
    if (
      source.observedStartPeriod !== null &&
      (source.observedStartPeriod as string) > (source.observedEndPeriod as string)
    ) {
      throw new PublicContractError("Source observed range end must not precede its start");
    }
    let previousYear: string | undefined;
    for (const item of arrayValue(source.byYear, "Source coverage years")) {
      const year = exactObject(item, "Source coverage year", ["evidenceCount", "period"]);
      validateYear(year.period, "Source coverage year");
      validateCount(year.evidenceCount, "Source evidence count");
      assertStrictlyIncreasing(year.period as string, previousYear, "Source coverage years");
      previousYear = year.period as string;
    }
    let previousGapAfter: string | undefined;
    for (const item of arrayValue(source.longGaps, "Source long gaps")) {
      const gap = exactObject(item, "Source long gap", [
        "afterPeriod",
        "beforePeriod",
        "durationDays",
      ]);
      validateMonth(gap.afterPeriod, "Gap after period");
      validateMonth(gap.beforePeriod, "Gap before period");
      validatePositiveCount(gap.durationDays, "Gap duration days");
      if ((gap.afterPeriod as string) >= (gap.beforePeriod as string)) {
        throw new PublicContractError("Source gap end must be after its start");
      }
      assertStrictlyIncreasing(gap.afterPeriod as string, previousGapAfter, "Source gap starts");
      previousGapAfter = gap.afterPeriod as string;
    }
  }
  if (
    seen.size !== includedSources.size ||
    [...seen].some((source) => !includedSources.has(source))
  ) {
    throw new PublicContractError("Source coverage must exactly match the included sources");
  }
}

function validateArtistsData(input: unknown): void {
  const object = exactObject(input, "Artists data", ["artists", "parameters"]);
  validateArtistEraParameters(object.parameters);
  const artists = boundedArray(
    object.artists,
    PUBLIC_SELECTION_POLICY.artistEligibility.maximumArtists,
    "Public artists",
  );
  const slugs = new Set<string>();
  for (const item of artists) {
    const artist = exactObject(item, "Public artist", ["displayName", "intervals", "slug"]);
    assertPublicSlugWithContract(artist.slug, "Artist slug");
    validateUniqueSlug(artist.slug, slugs, "Artist");
    validateRequiredText(artist.displayName, "Artist display name");
    const intervals = boundedArray(
      artist.intervals,
      PUBLIC_SELECTION_POLICY.artistEligibility.maximumIntervalsPerArtist,
      "Artist intervals",
    );
    const eligibilityIntervals: { readonly playCount: number; readonly strength: number }[] = [];
    let previousEndPeriod: string | undefined;
    for (const interval of intervals) {
      const validated = validateArtistInterval(interval);
      if (previousEndPeriod !== undefined && validated.startPeriod < previousEndPeriod) {
        throw new PublicContractError("Artist intervals must be ordered and non-overlapping");
      }
      previousEndPeriod = validated.endPeriodExclusive;
      eligibilityIntervals.push(validated);
    }
    if (
      !isPublicArtistEligible({
        displayName: artist.displayName as string,
        intervals: eligibilityIntervals,
        slug: artist.slug as string,
      })
    ) {
      throw new PublicContractError(`Artist does not meet public eligibility: ${artist.slug}`);
    }
  }
}

function validateArtistInterval(input: unknown): {
  readonly endPeriodExclusive: string;
  readonly playCount: number;
  readonly startPeriod: string;
  readonly strength: number;
} {
  const interval = exactObject(input, "Artist interval", [
    "endPeriodExclusive",
    "evidence",
    "peak",
    "playCount",
    "share",
    "startPeriod",
    "strength",
  ]);
  validateMonth(interval.startPeriod, "Artist interval start");
  validateMonth(interval.endPeriodExclusive, "Artist interval end");
  validateExclusiveMonthRange(
    interval.startPeriod as string,
    interval.endPeriodExclusive as string,
    "Artist interval",
  );
  validateCount(interval.playCount, "Artist interval play count");
  validateRate(interval.share, "Artist interval share");
  validateRate(interval.strength, "Artist interval strength");
  const peak = exactObject(interval.peak, "Artist interval peak", ["components", "period"]);
  validateMonth(peak.period, "Artist peak period");
  validateMonthWithinExclusiveRange(
    peak.period as string,
    interval.startPeriod as string,
    interval.endPeriodExclusive as string,
    "Artist peak period",
  );
  validateArtistComponents(peak.components);
  const evidenceRows = boundedArray(
    interval.evidence,
    PUBLIC_SELECTION_POLICY.artistEligibility.maximumEvidenceWindowsPerInterval,
    "Artist interval evidence",
  );
  if (evidenceRows.length === 0) {
    throw new PublicContractError("Artist interval requires aggregate evidence");
  }
  let evidencePlayCount = 0;
  let previousEvidencePeriod: string | undefined;
  let peakFound = false;
  for (const item of evidenceRows) {
    const evidence = exactObject(item, "Artist interval evidence item", ["components", "period"]);
    validateMonth(evidence.period, "Artist evidence period");
    validateMonthWithinExclusiveRange(
      evidence.period as string,
      interval.startPeriod as string,
      interval.endPeriodExclusive as string,
      "Artist evidence period",
    );
    assertStrictlyIncreasing(
      evidence.period as string,
      previousEvidencePeriod,
      "Artist evidence periods",
    );
    previousEvidencePeriod = evidence.period as string;
    validateArtistComponents(evidence.components);
    const components = evidence.components as Record<string, unknown>;
    evidencePlayCount += components.windowPlayCount as number;
    if (evidence.period === peak.period) {
      peakFound = true;
      const peakComponentValues = peak.components as Record<string, unknown>;
      if (artistComponentFields.some((field) => peakComponentValues[field] !== components[field])) {
        throw new PublicContractError("Artist peak components must match its evidence row");
      }
    }
  }
  if (!peakFound) throw new PublicContractError("Artist peak must match an evidence period");
  if (evidencePlayCount !== interval.playCount) {
    throw new PublicContractError("Artist interval play count must equal its evidence sum");
  }
  const peakComponents = peak.components as Record<string, unknown>;
  if (peakComponents.strength !== interval.strength) {
    throw new PublicContractError("Artist interval strength must equal its peak strength");
  }
  return {
    endPeriodExclusive: interval.endPeriodExclusive as string,
    playCount: interval.playCount as number,
    startPeriod: interval.startPeriod as string,
    strength: interval.strength as number,
  };
}

function validateArtistComponents(input: unknown): void {
  const components = exactObject(input, "Artist components", [
    "consecutiveActiveWindows",
    "earlierBaselineChange",
    "earlierBaselineRollingPlayCount",
    "listeningShare",
    "rank",
    "rollingPlayCount",
    "strength",
    "windowPlayCount",
  ]);
  validateCount(components.consecutiveActiveWindows, "Consecutive active windows");
  validateNullableSafeNumber(components.earlierBaselineChange, "Earlier baseline change");
  validateNullableCount(
    components.earlierBaselineRollingPlayCount,
    "Earlier baseline rolling play count",
  );
  validateRate(components.listeningShare, "Listening share");
  validatePositiveCount(components.rank, "Rank");
  validateCount(components.rollingPlayCount, "Rolling play count");
  validateRate(components.strength, "Component strength");
  validateCount(components.windowPlayCount, "Window play count");
}

function validateArtistEraParameters(input: unknown): void {
  const parameters = exactObject(input, "Artist-era parameters", [
    "maximumRank",
    "minimumConsecutiveActiveWindows",
    "minimumEarlierBaselineChange",
    "minimumListeningShare",
    "minimumRollingPlayCount",
    "minimumWindowPlayCount",
    "rollingWindowCount",
    "windowSizeMonths",
  ]);
  for (const key of [
    "maximumRank",
    "minimumConsecutiveActiveWindows",
    "minimumRollingPlayCount",
    "minimumWindowPlayCount",
    "rollingWindowCount",
    "windowSizeMonths",
  ] as const) {
    validatePositiveCount(parameters[key], `Artist-era ${key}`);
  }
  if ((parameters.maximumRank as number) > 100_000) {
    throw new PublicContractError("Artist-era maximum rank exceeds the supported bound");
  }
  if ((parameters.minimumConsecutiveActiveWindows as number) > 100) {
    throw new PublicContractError(
      "Artist-era consecutive-window threshold exceeds the supported bound",
    );
  }
  if ((parameters.rollingWindowCount as number) > 24) {
    throw new PublicContractError("Artist-era rolling-window count exceeds the supported bound");
  }
  if ((parameters.windowSizeMonths as number) > 12) {
    throw new PublicContractError("Artist-era window size exceeds the supported bound");
  }
  validateSafeInteger(parameters.minimumEarlierBaselineChange, "Artist-era baseline change");
  validatePositiveRate(parameters.minimumListeningShare, "Artist-era minimum listening share");
}

interface PublicRediscoveryParameters {
  readonly absenceThresholdDays: number;
  readonly minimumPersistencePlayCount: number;
  readonly minimumPriorPlayCount: number;
  readonly minimumReturnPlayCount: number;
  readonly persistenceWindowDays: number;
  readonly returnWindowDays: number;
  readonly scope: "artist" | "track";
}

function validateRediscoveryParameters(input: unknown): PublicRediscoveryParameters {
  const parameters = exactObject(input, "Rediscovery parameters", [
    "absenceThresholdDays",
    "minimumPersistencePlayCount",
    "minimumPriorPlayCount",
    "minimumReturnPlayCount",
    "persistenceWindowDays",
    "returnWindowDays",
    "scope",
  ]);
  for (const key of [
    "absenceThresholdDays",
    "minimumPersistencePlayCount",
    "minimumPriorPlayCount",
    "minimumReturnPlayCount",
    "persistenceWindowDays",
    "returnWindowDays",
  ] as const) {
    validatePositiveCount(parameters[key], `Rediscovery ${key}`);
  }
  if ((parameters.absenceThresholdDays as number) > 3_650) {
    throw new PublicContractError("Rediscovery absence threshold exceeds the supported bound");
  }
  if (
    (parameters.returnWindowDays as number) > 365 ||
    (parameters.persistenceWindowDays as number) > 730
  ) {
    throw new PublicContractError("Rediscovery observation window exceeds the supported bound");
  }
  if (parameters.scope !== "artist" && parameters.scope !== "track") {
    throw new PublicContractError("Rediscovery scope must be artist or track");
  }
  return parameters as unknown as PublicRediscoveryParameters;
}

interface PublicDormancyParameters {
  readonly activePeriodGapDays: number;
  readonly dormancyDays: number;
  readonly formerCadenceWindowDays: number;
  readonly likelyAbandonedDays: number;
  readonly minimumFormerCadencePlayCount: number;
  readonly minimumHistoricalPlayCount: number;
  readonly observationWindowDays: number;
}

function validateDormancyParameters(input: unknown): PublicDormancyParameters {
  const parameters = exactObject(input, "Dormancy parameters", [
    "activePeriodGapDays",
    "dormancyDays",
    "formerCadenceWindowDays",
    "likelyAbandonedDays",
    "minimumFormerCadencePlayCount",
    "minimumHistoricalPlayCount",
    "observationWindowDays",
  ]);
  for (const key of [
    "activePeriodGapDays",
    "dormancyDays",
    "formerCadenceWindowDays",
    "likelyAbandonedDays",
    "minimumFormerCadencePlayCount",
    "minimumHistoricalPlayCount",
    "observationWindowDays",
  ] as const) {
    validatePositiveCount(parameters[key], `Dormancy ${key}`);
  }
  if ((parameters.activePeriodGapDays as number) > 365) {
    throw new PublicContractError("Dormancy active-period gap exceeds the supported bound");
  }
  if (
    (parameters.formerCadenceWindowDays as number) > 3_650 ||
    (parameters.observationWindowDays as number) > 3_650
  ) {
    throw new PublicContractError("Dormancy observation window exceeds the supported bound");
  }
  if ((parameters.dormancyDays as number) > (parameters.likelyAbandonedDays as number)) {
    throw new PublicContractError("Dormancy threshold must not exceed likely-abandoned threshold");
  }
  return parameters as unknown as PublicDormancyParameters;
}

function validateEditorialData(input: unknown): void {
  const object = exactObject(input, "Editorial data", ["annotations", "featuredArtists"]);
  const slugs = new Set<string>();
  for (const item of boundedArray(
    object.annotations,
    PUBLIC_SELECTION_POLICY.resultLimits.maximumAnnotations,
    "Annotations",
  )) {
    const annotation = exactObject(item, "Annotation", [...commonEditorialKeys, "period", "route"]);
    validateCommonEditorial(annotation, slugs, "Annotation");
    validatePublicRoute(annotation.route, "Annotation route");
    validateNullableMonth(annotation.period, "Annotation period");
  }
  for (const item of boundedArray(
    object.featuredArtists,
    PUBLIC_SELECTION_POLICY.resultLimits.maximumFeaturedArtists,
    "Featured artists",
  )) {
    const featured = exactObject(item, "Featured artist", [
      ...commonEditorialKeys,
      "artistSlug",
      "storySlugs",
    ]);
    validateCommonEditorial(featured, slugs, "Featured artist");
    assertPublicSlugWithContract(featured.artistSlug, "Featured artist reference");
    validateSlugList(featured.storySlugs, "Featured artist story references");
  }
}

const commonEditorialKeys = [
  "accessibilitySummary",
  "body",
  "contentSchemaVersion",
  "order",
  "publicReferences",
  "publicationStatus",
  "slug",
  "summary",
  "title",
] as const;

function validateCommonEditorial(
  object: Record<string, unknown>,
  slugs: Set<string>,
  label: string,
): void {
  expectEqual(object.contentSchemaVersion, "public-content-v1", `${label} content schema version`);
  assertPublicSlugWithContract(object.slug, `${label} slug`);
  validateUniqueSlug(object.slug, slugs, label);
  expectEqual(object.publicationStatus, "published", `${label} publication status`);
  validateRequiredText(object.title, `${label} title`);
  validateRequiredText(object.summary, `${label} summary`);
  validateBody(object.body, `${label} body`);
  validateCount(object.order, `${label} order`);
  validateRequiredText(object.accessibilitySummary, `${label} accessibility summary`);
  validatePublicReferences(object.publicReferences, `${label} public references`);
}

function validateBody(input: unknown, label: string): void {
  for (const item of arrayValue(input, label)) {
    const section = exactObject(item, `${label} section`, ["heading", "paragraphs"]);
    if (section.heading !== null) validateRequiredText(section.heading, `${label} heading`);
    const paragraphs = arrayValue(section.paragraphs, `${label} paragraphs`);
    if (paragraphs.length === 0)
      throw new PublicContractError(`${label} section needs a paragraph`);
    for (const paragraph of paragraphs) validateRequiredText(paragraph, `${label} paragraph`);
  }
}

function validateStoriesData(input: unknown, asOfDate: unknown): readonly PublicAnalysisName[] {
  const object = exactObject(input, "Stories data", ["stories"]);
  const stories = boundedArray(
    object.stories,
    PUBLIC_SELECTION_POLICY.resultLimits.maximumStories,
    "Stories",
  );
  const slugs = new Set<string>();
  const requiredAnalyses = new Set<PublicAnalysisName>();
  const validatedStories: Record<string, unknown>[] = [];
  for (const item of stories) {
    const story = exactObject(item, "Story", [
      ...commonEditorialKeys,
      "artistSlug",
      "evidence",
      "kind",
      "parameters",
      "selectedTrack",
      "supersedesStorySlug",
    ]);
    validateCommonEditorial(story, slugs, "Story");
    if (story.kind !== "rediscovery" && story.kind !== "dormancy") {
      throw new PublicContractError("Story kind must be rediscovery or dormancy");
    }
    if (story.artistSlug !== null)
      assertPublicSlugWithContract(story.artistSlug, "Story artist slug");
    if (story.supersedesStorySlug !== null) {
      assertPublicSlugWithContract(story.supersedesStorySlug, "Superseded story slug");
    }
    validateSelectedTrack(story.selectedTrack, story.slug as string);
    if (story.kind === "rediscovery") {
      requiredAnalyses.add("rediscovery");
      validateRediscoveryEvidence(story.evidence, story.parameters);
    } else {
      requiredAnalyses.add("abandonment");
      validateDormancyEvidence(story.evidence, story.parameters, asOfDate);
    }
    validatedStories.push(story);
  }
  validatePublicStorySupersessions(validatedStories);
  return [...requiredAnalyses].toSorted();
}

function validatePublicStorySupersessions(stories: readonly Record<string, unknown>[]): void {
  const bySlug = new Map(stories.map((story) => [story.slug as string, story]));
  for (const story of stories) {
    if (story.supersedesStorySlug === null) continue;
    if (story.kind !== "rediscovery") {
      throw new PublicContractError("Only a rediscovery story may supersede another story");
    }
    const superseded = bySlug.get(story.supersedesStorySlug as string);
    if (superseded?.kind !== "dormancy") {
      throw new PublicContractError(
        "A rediscovery story may supersede only a present dormancy story",
      );
    }
    if (
      story.artistSlug !== null &&
      superseded.artistSlug !== null &&
      story.artistSlug !== superseded.artistSlug
    ) {
      throw new PublicContractError("Superseding stories must name the same public artist");
    }
    const rediscoveryEvidence = story.evidence as Record<string, unknown>;
    const dormancyEvidence = superseded.evidence as Record<string, unknown>;
    if (
      (rediscoveryEvidence.returnPeriod as string) <= (dormancyEvidence.lastListenPeriod as string)
    ) {
      throw new PublicContractError(
        "A superseding rediscovery must occur after the dormant artist's last listen",
      );
    }
  }
}

function validateSelectedTrack(input: unknown, storySlug: string): void {
  if (input === null) return;
  const track = exactObject(input, "Selected track", [
    "artistDisplayName",
    "slug",
    "storySlug",
    "trackDisplayName",
  ]);
  validateRequiredText(track.artistDisplayName, "Selected track artist display name");
  assertPublicSlugWithContract(track.slug, "Selected track slug");
  expectEqual(track.storySlug, storySlug, "Selected track story slug");
  validateRequiredText(track.trackDisplayName, "Selected track display name");
}

function validateRediscoveryEvidence(input: unknown, parametersInput: unknown): void {
  const parameters = validateRediscoveryParameters(parametersInput);
  const evidence = exactObject(input, "Rediscovery evidence", [
    "classification",
    "gapDays",
    "persistence",
    "persistencePlayCount",
    "priorPeriod",
    "priorPlayCount",
    "relatedEra",
    "returnIntensity",
    "returnPeriod",
    "returnWindowComplete",
  ]);
  if (
    evidence.classification !== "one_off_return" &&
    evidence.classification !== "return_beginning_new_era" &&
    evidence.classification !== "sustained_rediscovery"
  ) {
    throw new PublicContractError("Invalid rediscovery classification");
  }
  if (
    evidence.persistence !== "not_persistent" &&
    evidence.persistence !== "open" &&
    evidence.persistence !== "persistent"
  ) {
    throw new PublicContractError("Invalid rediscovery persistence");
  }
  validateNonNegativeNumber(evidence.gapDays, "Rediscovery gap days");
  validateCount(evidence.persistencePlayCount, "Rediscovery persistence play count");
  validateMonth(evidence.priorPeriod, "Rediscovery prior period");
  validateCount(evidence.priorPlayCount, "Rediscovery prior play count");
  validateCount(evidence.returnIntensity, "Rediscovery return intensity");
  validateMonth(evidence.returnPeriod, "Rediscovery return period");
  if ((evidence.priorPeriod as string) > (evidence.returnPeriod as string)) {
    throw new PublicContractError("Rediscovery prior period must not follow its return period");
  }
  validateReducedMonthDaySpan(
    evidence.gapDays as number,
    evidence.priorPeriod as string,
    evidence.returnPeriod as string,
    "Rediscovery gap days",
  );
  if ((evidence.gapDays as number) < parameters.absenceThresholdDays) {
    throw new PublicContractError("Rediscovery gap must meet its published absence threshold");
  }
  if ((evidence.priorPlayCount as number) < parameters.minimumPriorPlayCount) {
    throw new PublicContractError("Rediscovery prior count must meet its published threshold");
  }
  if ((evidence.returnIntensity as number) < parameters.minimumReturnPlayCount) {
    throw new PublicContractError("Rediscovery return count must meet its published threshold");
  }
  if (typeof evidence.returnWindowComplete !== "boolean") {
    throw new PublicContractError("Rediscovery return window complete must be boolean");
  }
  if (evidence.relatedEra !== null) {
    const era = exactObject(evidence.relatedEra, "Rediscovery related era", [
      "endPeriodExclusive",
      "startPeriod",
    ]);
    validateMonth(era.startPeriod, "Related era start");
    validateMonth(era.endPeriodExclusive, "Related era end");
    validateExclusiveMonthRange(
      era.startPeriod as string,
      era.endPeriodExclusive as string,
      "Rediscovery related era",
    );
  }
  if (
    evidence.classification === "sustained_rediscovery" &&
    (evidence.persistence !== "persistent" ||
      (evidence.persistencePlayCount as number) < parameters.minimumPersistencePlayCount)
  ) {
    throw new PublicContractError("Sustained rediscovery must meet its persistence threshold");
  }
  if (evidence.classification === "one_off_return" && evidence.persistence === "persistent") {
    throw new PublicContractError("One-off rediscovery cannot claim persistent evidence");
  }
  if (
    evidence.persistence === "not_persistent" &&
    (evidence.persistencePlayCount as number) >= parameters.minimumPersistencePlayCount
  ) {
    throw new PublicContractError(
      "Non-persistent rediscovery cannot meet the persistence threshold",
    );
  }
  if (evidence.classification === "return_beginning_new_era" && evidence.relatedEra === null) {
    throw new PublicContractError("A new-era rediscovery requires related era evidence");
  }
}

function validateDormancyEvidence(
  input: unknown,
  parametersInput: unknown,
  asOfDate: unknown,
): void {
  const parameters = validateDormancyParameters(parametersInput);
  const evidence = exactObject(input, "Dormancy evidence", [
    "activePeriodCount",
    "confidence",
    "formerCadencePlaysPer30Days",
    "formerCadencePlayCount",
    "historicalPlayCount",
    "lastActivePeriod",
    "lastListenPeriod",
    "observationDays",
    "status",
  ]);
  if (evidence.status !== "dormant" && evidence.status !== "likely_abandoned_as_of") {
    throw new PublicContractError("Invalid dormancy status");
  }
  validateCount(evidence.activePeriodCount, "Dormancy active period count");
  validateNonNegativeNumber(evidence.formerCadencePlaysPer30Days, "Former cadence per 30 days");
  validateCount(evidence.formerCadencePlayCount, "Former cadence play count");
  validateCount(evidence.historicalPlayCount, "Historical play count");
  validateMonth(evidence.lastListenPeriod, "Last-listen period");
  validateNonNegativeNumber(evidence.observationDays, "Observation days");
  const active = exactObject(evidence.lastActivePeriod, "Last active period", [
    "endPeriod",
    "playCount",
    "startPeriod",
  ]);
  validateMonth(active.startPeriod, "Last active period start");
  validateMonth(active.endPeriod, "Last active period end");
  if ((active.startPeriod as string) > (active.endPeriod as string)) {
    throw new PublicContractError("Last active period end must not precede its start");
  }
  if (evidence.lastListenPeriod !== active.endPeriod) {
    throw new PublicContractError("Last-listen period must equal the last active period end");
  }
  if (typeof asOfDate !== "string") {
    throw new PublicContractError("A dormancy story requires a public as-of date");
  }
  validateReducedMonthToDateDaySpan(
    evidence.observationDays as number,
    evidence.lastListenPeriod as string,
    asOfDate,
    "Dormancy observation days",
  );
  validateCount(active.playCount, "Last active period play count");
  const confidence = exactObject(evidence.confidence, "Dormancy confidence", [
    "formerCadence",
    "historicalImportance",
    "observationCompleteness",
    "score",
  ]);
  for (const [key, value] of Object.entries(confidence)) validateRate(value, `Confidence ${key}`);
  const expectedConfidence =
    ((confidence.formerCadence as number) +
      (confidence.historicalImportance as number) +
      (confidence.observationCompleteness as number)) /
    3;
  if (confidence.score !== expectedConfidence) {
    throw new PublicContractError("Dormancy confidence score must equal its component mean");
  }
  const expectedCadence =
    ((evidence.formerCadencePlayCount as number) * 30) / parameters.formerCadenceWindowDays;
  if (evidence.formerCadencePlaysPer30Days !== expectedCadence) {
    throw new PublicContractError("Dormancy cadence rate must reconcile to its count and window");
  }
  if ((evidence.historicalPlayCount as number) < parameters.minimumHistoricalPlayCount) {
    throw new PublicContractError("Dormancy history must meet its published threshold");
  }
  if ((evidence.formerCadencePlayCount as number) < parameters.minimumFormerCadencePlayCount) {
    throw new PublicContractError("Dormancy cadence must meet its published threshold");
  }
  if ((evidence.observationDays as number) < parameters.dormancyDays) {
    throw new PublicContractError("Dormancy observation must meet its published threshold");
  }
  if (
    evidence.status === "likely_abandoned_as_of" &&
    ((evidence.observationDays as number) < parameters.likelyAbandonedDays ||
      (evidence.observationDays as number) < parameters.observationWindowDays)
  ) {
    throw new PublicContractError(
      "Likely-abandoned status requires its published observation bounds",
    );
  }
}

function validateGenreLabData(input: unknown): void {
  const object = exactObject(input, "Genre lab data", [
    "contributionVersion",
    "coverageByYear",
    "freshnessDate",
    "genres",
    "mode",
    "parameters",
    "provider",
    "status",
    "taxonomyVersion",
    "usableEventCoverage",
    "weightingLevel",
  ]);
  expectEqual(object.status, "experimental", "Genre status");
  expectEqual(object.provider, "musicbrainz", "Genre provider");
  expectEqual(object.mode, "raw", "Genre mode");
  if (object.taxonomyVersion !== null) {
    throw new PublicContractError("Raw experimental genre data must have null taxonomy version");
  }
  expectEqual(object.weightingLevel, "artist", "Genre weighting level");
  expectEqual(object.contributionVersion, "genre-contribution-v2", "Genre contribution version");
  validateGenreEraParameters(object.parameters);
  validateDate(object.freshnessDate, "Genre freshness date");
  validateCoverageRate(object.usableEventCoverage, "Genre usable event coverage");
  let previousCoverageYear: string | undefined;
  let yearlyUsableTotal = 0;
  let yearlyEventTotal = 0;
  for (const item of arrayValue(object.coverageByYear, "Genre coverage by year")) {
    const row = exactObject(item, "Genre coverage year", [
      "period",
      "rate",
      "totalEventCount",
      "usableEventCount",
    ]);
    validateYear(row.period, "Genre coverage period");
    assertStrictlyIncreasing(row.period as string, previousCoverageYear, "Genre coverage years");
    previousCoverageYear = row.period as string;
    validateCoverageRate(
      {
        availableEventCount: row.usableEventCount,
        rate: row.rate,
        totalEventCount: row.totalEventCount,
      },
      "Genre yearly usable event coverage",
    );
    yearlyUsableTotal += row.usableEventCount as number;
    yearlyEventTotal += row.totalEventCount as number;
  }
  const overallCoverage = object.usableEventCoverage as Record<string, unknown>;
  if (
    yearlyUsableTotal !== overallCoverage.availableEventCount ||
    yearlyEventTotal !== overallCoverage.totalEventCount
  ) {
    throw new PublicContractError("Genre yearly coverage must reconcile to overall coverage");
  }
  const genres = boundedArray(
    object.genres,
    PUBLIC_SELECTION_POLICY.resultLimits.maximumGenres,
    "Genres",
  );
  let intervalCount = 0;
  const slugs = new Set<string>();
  for (const item of genres) {
    const genre = exactObject(item, "Genre", ["intervals", "label", "slug"]);
    assertPublicSlugWithContract(genre.slug, "Genre slug");
    validateUniqueSlug(genre.slug, slugs, "Genre");
    validateRequiredText(genre.label, "Genre label");
    const intervals = arrayValue(genre.intervals, "Genre intervals");
    intervalCount += intervals.length;
    let previousEndPeriod: string | undefined;
    for (const item of intervals) {
      const interval = validateGenreInterval(item);
      if (previousEndPeriod !== undefined && interval.startPeriod < previousEndPeriod) {
        throw new PublicContractError("Genre intervals must be ordered and non-overlapping");
      }
      previousEndPeriod = interval.endPeriodExclusive;
    }
  }
  if (intervalCount > PUBLIC_SELECTION_POLICY.resultLimits.maximumGenreIntervals) {
    throw new PublicContractError("Genre intervals exceed the public result limit");
  }
}

function validateGenreInterval(input: unknown): {
  readonly endPeriodExclusive: string;
  readonly startPeriod: string;
} {
  const interval = exactObject(input, "Genre interval", [
    "contribution",
    "endPeriodExclusive",
    "peakPeriod",
    "share",
    "startPeriod",
    "strength",
  ]);
  validateSafeNumber(interval.contribution, "Genre contribution");
  validateMonth(interval.startPeriod, "Genre interval start");
  validateMonth(interval.endPeriodExclusive, "Genre interval end");
  validateExclusiveMonthRange(
    interval.startPeriod as string,
    interval.endPeriodExclusive as string,
    "Genre interval",
  );
  validateMonth(interval.peakPeriod, "Genre interval peak");
  validateMonthWithinExclusiveRange(
    interval.peakPeriod as string,
    interval.startPeriod as string,
    interval.endPeriodExclusive as string,
    "Genre peak period",
  );
  validateRate(interval.share, "Genre interval share");
  validateRate(interval.strength, "Genre interval strength");
  if (
    (interval.contribution as number) <
      PUBLIC_SELECTION_POLICY.genreEligibility.minimumIntervalContribution ||
    (interval.strength as number) < PUBLIC_SELECTION_POLICY.genreEligibility.minimumPeakStrength
  ) {
    throw new PublicContractError("Genre interval does not meet the sparse-group publication gate");
  }
  return {
    endPeriodExclusive: interval.endPeriodExclusive as string,
    startPeriod: interval.startPeriod as string,
  };
}

function validateGenreEraParameters(input: unknown): void {
  const parameters = exactObject(input, "Genre-era parameters", [
    "maximumRank",
    "minimumConsecutiveActiveWindows",
    "minimumEarlierBaselineChange",
    "minimumListeningShare",
    "minimumRollingContribution",
    "minimumWindowContribution",
    "rollingWindowCount",
    "windowSizeMonths",
  ]);
  for (const key of [
    "maximumRank",
    "minimumConsecutiveActiveWindows",
    "rollingWindowCount",
    "windowSizeMonths",
  ] as const) {
    validatePositiveCount(parameters[key], `Genre-era ${key}`);
  }
  if (
    (parameters.maximumRank as number) > 100_000 ||
    (parameters.minimumConsecutiveActiveWindows as number) > 100 ||
    (parameters.rollingWindowCount as number) > 24 ||
    (parameters.windowSizeMonths as number) > 12
  ) {
    throw new PublicContractError("Genre-era integer parameter exceeds its supported bound");
  }
  validateSafeNumber(parameters.minimumEarlierBaselineChange, "Genre-era baseline change");
  validatePositiveRate(parameters.minimumListeningShare, "Genre-era minimum listening share");
  validatePositiveNumber(
    parameters.minimumRollingContribution,
    "Genre-era minimum rolling contribution",
  );
  validatePositiveNumber(
    parameters.minimumWindowContribution,
    "Genre-era minimum window contribution",
  );
}

function validateCoverage(input: unknown): void {
  const coverage = exactObject(input, "Public coverage", [
    "canonicalEventCount",
    "dateRange",
    "includedSources",
    "spotifyDurationEventCount",
    "unresolvedRate",
  ]);
  validateCount(coverage.canonicalEventCount, "Canonical event count");
  validateCount(coverage.spotifyDurationEventCount, "Spotify duration event count");
  if ((coverage.spotifyDurationEventCount as number) > (coverage.canonicalEventCount as number)) {
    throw new PublicContractError("Spotify duration event count cannot exceed canonical events");
  }
  validateRate(coverage.unresolvedRate, "Unresolved rate");
  const sources = arrayValue(coverage.includedSources, "Included sources");
  if (sources.length === 0) throw new PublicContractError("Included sources must not be empty");
  const unique = new Set<PublicSource>();
  let previousSource: string | undefined;
  for (const source of sources) {
    const name = validateSource(source);
    assertStrictlyIncreasing(name, previousSource, "Included sources");
    previousSource = name;
    unique.add(name);
  }
  if (unique.size !== sources.length)
    throw new PublicContractError("Included sources must be unique");
  if (coverage.dateRange === null) {
    if (coverage.canonicalEventCount !== 0) {
      throw new PublicContractError("Only empty coverage may omit the public date range");
    }
  } else {
    const range = exactObject(coverage.dateRange, "Public date range", [
      "endPeriodExclusive",
      "startPeriod",
    ]);
    validateMonth(range.startPeriod, "Public date range start");
    validateMonth(range.endPeriodExclusive, "Public date range end");
    if ((range.startPeriod as string) >= (range.endPeriodExclusive as string)) {
      throw new PublicContractError("Public date range end must be after its start");
    }
  }
}

function validateArtifactDateContext(asOfDate: unknown, coverageInput: unknown): void {
  const coverage = coverageInput as Record<string, unknown>;
  if (coverage.canonicalEventCount === 0) {
    if (asOfDate !== null) {
      throw new PublicContractError("Empty public coverage must have a null as-of date");
    }
  } else if (asOfDate === null) {
    throw new PublicContractError("Populated public coverage requires an as-of date");
  }
}

function validateAnalyticalVersions(input: unknown): ReadonlySet<PublicAnalysisName> {
  const versions = arrayValue(input, "Analytical versions");
  const names = new Set<PublicAnalysisName>();
  let previousAnalysis: string | undefined;
  for (const item of versions) {
    const version = exactObject(item, "Analytical version", [
      "analysis",
      "analysisVersion",
      "parameterSchemaVersion",
      "queryVersion",
    ]);
    validateRequiredText(version.analysis, "Analysis name");
    validateRequiredText(version.analysisVersion, "Analysis version");
    validateRequiredText(version.parameterSchemaVersion, "Parameter schema version");
    validateRequiredText(version.queryVersion, "Query version");
    if (!((version.analysis as string) in PUBLIC_ANALYTICAL_VERSION_CONTRACTS)) {
      throw new PublicContractError("Analytical version names an unsupported public analysis");
    }
    const analysis = version.analysis as PublicAnalysisName;
    assertStrictlyIncreasing(analysis, previousAnalysis, "Analytical versions");
    previousAnalysis = analysis;
    const expected = PUBLIC_ANALYTICAL_VERSION_CONTRACTS[analysis];
    expectEqual(version.analysisVersion, expected.analysisVersion, `${analysis} analysis version`);
    expectEqual(
      version.parameterSchemaVersion,
      expected.parameterSchemaVersion,
      `${analysis} parameter schema version`,
    );
    expectEqual(version.queryVersion, expected.queryVersion, `${analysis} query version`);
    if (names.has(analysis)) {
      throw new PublicContractError(`Duplicate analytical version: ${version.analysis}`);
    }
    names.add(analysis);
  }
  return names;
}

function requireAnalyticalVersions(
  names: ReadonlySet<PublicAnalysisName>,
  required: readonly PublicAnalysisName[],
  label: string,
): void {
  for (const analysis of required) {
    if (!names.has(analysis)) {
      throw new PublicContractError(`${label} is missing its required analytical version`);
    }
  }
}

function validateManifestArtifact(input: unknown, artifact: PublicArtifactName): void {
  const reference = exactObject(input, `${artifact} artifact reference`, ["file", "sha256"]);
  expectEqual(reference.file, PUBLIC_ARTIFACT_FILES[artifact], `${artifact} public filename`);
  validateSha256(reference.sha256, `${artifact} artifact hash`);
}

function validateApproval(input: unknown, reportSha256: unknown): void {
  const approval = exactObject(input, "Approval", ["decidedOn", "decision", "reportSha256"]);
  expectEqual(approval.decision, "approved", "Approval decision");
  validateDate(approval.decidedOn, "Approval date");
  validateSha256(approval.reportSha256, "Approval report hash");
  if (approval.reportSha256 !== reportSha256) {
    throw new PublicContractError("Approval must bind the exact reviewed report hash");
  }
}

function validateCoverageRate(input: unknown, label: string): void {
  const coverage = exactObject(input, label, ["availableEventCount", "rate", "totalEventCount"]);
  validateCount(coverage.availableEventCount, `${label} available event count`);
  validateCount(coverage.totalEventCount, `${label} total event count`);
  validateRate(coverage.rate, `${label} rate`);
  if ((coverage.availableEventCount as number) > (coverage.totalEventCount as number)) {
    throw new PublicContractError(`${label} available count cannot exceed total count`);
  }
  const expected =
    coverage.totalEventCount === 0
      ? 0
      : (coverage.availableEventCount as number) / (coverage.totalEventCount as number);
  if (coverage.rate !== expected) throw new PublicContractError(`${label} rate is inconsistent`);
}

function validateCountObject<const TKeys extends readonly string[]>(
  input: unknown,
  label: string,
  keys: TKeys,
): Record<TKeys[number], number> {
  const object = exactObject(input, label, keys);
  for (const key of keys) validateCount(object[key], `${label} ${key}`);
  return object as Record<TKeys[number], number>;
}

function validateArtifactName(value: unknown): PublicArtifactName {
  if (
    value !== "history" &&
    value !== "artists" &&
    value !== "editorial" &&
    value !== "stories" &&
    value !== "genre-lab"
  ) {
    throw new PublicContractError("Unknown public artifact name");
  }
  return value;
}

function validateSource(value: unknown): PublicSource {
  if (value !== "lastfm" && value !== "spotify") {
    throw new PublicContractError("Public source must be lastfm or spotify");
  }
  return value;
}

function validateSnapshotId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^snapshot-\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  ) {
    throw new PublicContractError("Snapshot ID must be a stable public snapshot slug");
  }
}

function validateTimezone(value: unknown): asserts value is string {
  validateRequiredText(value, "Presentation timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    throw new PublicContractError("Presentation timezone must name a valid IANA timezone");
  }
}

function validateMonth(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value)) {
    throw new PublicContractError(`${label} must use YYYY-MM public month granularity`);
  }
}

function validateReducedMonthDaySpan(
  days: number,
  earlierMonth: string,
  laterMonth: string,
  label: string,
): void {
  const earlier = conservativeMonthUtcBounds(earlierMonth);
  const later = conservativeMonthUtcBounds(laterMonth);
  const minimumDays = Math.max(0, (later.start - earlier.endExclusive) / DAY_MS);
  const maximumDays = (later.endExclusive - earlier.start) / DAY_MS;
  validateDayCountRange(days, minimumDays, maximumDays, label);
}

function validateReducedMonthToDateDaySpan(
  days: number,
  earlierMonth: string,
  laterDate: string,
  label: string,
): void {
  const earlier = conservativeMonthUtcBounds(earlierMonth);
  const laterStart = Date.parse(`${laterDate}T00:00:00.000Z`);
  const minimumDays = Math.max(0, (laterStart - earlier.endExclusive) / DAY_MS);
  const maximumDays = (laterStart + DAY_MS - earlier.start) / DAY_MS;
  validateDayCountRange(days, minimumDays, maximumDays, label);
}

function conservativeMonthUtcBounds(month: string): {
  readonly endExclusive: number;
  readonly start: number;
} {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  return {
    endExclusive: Date.UTC(year, monthIndex + 1, 1) + DAY_MS,
    start: Date.UTC(year, monthIndex, 1) - DAY_MS,
  };
}

function validateDayCountRange(
  days: number,
  minimumDays: number,
  maximumDays: number,
  label: string,
): void {
  if (days + DAY_COUNT_TOLERANCE < minimumDays || days - DAY_COUNT_TOLERANCE > maximumDays) {
    throw new PublicContractError(`${label} does not reconcile to its reduced public dates`);
  }
}

function validateNullableMonth(value: unknown, label: string): void {
  if (value !== null) validateMonth(value, label);
}

function validateExclusiveMonthRange(start: string, endExclusive: string, label: string): void {
  if (start >= endExclusive) {
    throw new PublicContractError(`${label} end must be after its start`);
  }
}

function validateMonthWithinExclusiveRange(
  value: string,
  start: string,
  endExclusive: string,
  label: string,
): void {
  if (value < start || value >= endExclusive) {
    throw new PublicContractError(`${label} must fall within its interval`);
  }
}

function assertStrictlyIncreasing(
  value: string,
  previous: string | undefined,
  label: string,
): void {
  if (previous !== undefined && value <= previous) {
    throw new PublicContractError(`${label} must be unique and strictly increasing`);
  }
}

function validateYear(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}$/u.test(value)) {
    throw new PublicContractError(`${label} must use YYYY public year granularity`);
  }
}

function validateDate(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new PublicContractError(`${label} must use YYYY-MM-DD public date granularity`);
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new PublicContractError(`${label} must be a valid date`);
  }
}

function validateDateOrNull(value: unknown, label: string): void {
  if (value !== null) validateDate(value, label);
}

function validateSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new PublicContractError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function validateCount(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PublicContractError(`${label} must be a non-negative safe integer`);
  }
}

function validatePositiveCount(value: unknown, label: string): asserts value is number {
  validateCount(value, label);
  if (value === 0) throw new PublicContractError(`${label} must be positive`);
}

function validateSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PublicContractError(`${label} must be a safe integer`);
  }
}

function validateNullableCount(value: unknown, label: string): void {
  if (value !== null) validateCount(value, label);
}

function validateRate(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new PublicContractError(`${label} must be a number from 0 through 1`);
  }
}

function validatePositiveRate(value: unknown, label: string): asserts value is number {
  validateRate(value, label);
  if (value === 0) throw new PublicContractError(`${label} must be greater than zero`);
}

function validateSafeNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PublicContractError(`${label} must be a finite number`);
  }
}

function validateNonNegativeNumber(value: unknown, label: string): asserts value is number {
  validateSafeNumber(value, label);
  if (value < 0) throw new PublicContractError(`${label} must be non-negative`);
}

function validatePositiveNumber(value: unknown, label: string): asserts value is number {
  validateSafeNumber(value, label);
  if (value <= 0) throw new PublicContractError(`${label} must be greater than zero`);
}

function validateBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new PublicContractError(`${label} must be a boolean`);
}

function validateNullableSafeNumber(value: unknown, label: string): void {
  if (value !== null) validateSafeNumber(value, label);
}

function validateRequiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || /\p{Cc}/u.test(value)) {
    throw new PublicContractError(`${label} must be non-empty and contain no control characters`);
  }
}

function validatePublicReferences(input: unknown, label: string): void {
  const references = arrayValue(input, label);
  const seen = new Set<string>();
  for (const value of references) {
    validateRequiredText(value, label);
    const reference = value as string;
    if (reference.length > 2_048) {
      throw new PublicContractError(`${label} must not exceed 2048 characters`);
    }
    if (reference.startsWith("/")) {
      validatePublicRouteReference(reference, label);
    } else {
      validateReviewedExternalLink(reference, label);
    }
    if (seen.has(reference)) throw new PublicContractError(`${label} must be unique`);
    seen.add(reference);
  }
}

function validatePublicRoute(value: unknown, label: string): asserts value is string {
  validateRequiredText(value, label);
  validatePublicRoutePath(value as string, label);
}

function validatePublicRouteReference(value: string, label: string): void {
  if (value.includes("?")) {
    throw new PublicContractError(`${label} must not contain unreviewed query state`);
  }
  const [path, fragment, ...rest] = value.split("#");
  if (rest.length !== 0 || path === undefined) {
    throw new PublicContractError(`${label} must be a valid public route reference`);
  }
  validatePublicRoutePath(path, label);
  if (fragment !== undefined) assertPublicSlugWithContract(fragment, `${label} fragment`);
}

function validatePublicRoutePath(value: string, label: string): void {
  if (
    value !== "/" &&
    value !== "/history/" &&
    value !== "/artists/" &&
    value !== "/stories/" &&
    value !== "/explore/" &&
    value !== "/methodology/" &&
    value !== "/lab/genres/" &&
    !/^\/(?:artists|stories)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/u.test(value)
  ) {
    throw new PublicContractError(`${label} must name an allowlisted same-origin public route`);
  }
}

function validateReviewedExternalLink(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicContractError(`${label} must be an allowlisted route or reviewed HTTPS link`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== ""
  ) {
    throw new PublicContractError(
      `${label} must be a credential-free HTTPS link without query data`,
    );
  }
}

function validateSlugList(input: unknown, label: string): void {
  const values = arrayValue(input, label);
  const unique = new Set<string>();
  let previous: string | undefined;
  for (const value of values) {
    assertPublicSlugWithContract(value, label);
    if (unique.has(value as string)) throw new PublicContractError(`${label} must be unique`);
    assertStrictlyIncreasing(value as string, previous, label);
    previous = value as string;
    unique.add(value as string);
  }
}

function validateExactStringList(input: unknown, expected: readonly string[], label: string): void {
  const values = arrayValue(input, label);
  if (
    values.length !== expected.length ||
    values.some((value, index) => value !== expected[index])
  ) {
    throw new PublicContractError(`${label} must exactly match the executable public allowlist`);
  }
}

function expectEqual(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new PublicContractError(`${label} must be ${expected}`);
}

function exactObject(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new PublicContractError(`${label} must be a plain JSON object`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PublicContractError(`${label} contains unknown field: ${key}`);
  }
  for (const key of allowedKeys) {
    if (!(key in value))
      throw new PublicContractError(`${label} is missing required field: ${key}`);
  }
  return value;
}

function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new PublicContractError(`${label} must be an array`);
  return value;
}

function boundedArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  const array = arrayValue(value, label);
  if (array.length > maximum)
    throw new PublicContractError(`${label} exceeds its public result limit`);
  return array;
}

function validateUniqueSlug(value: unknown, slugs: Set<string>, label: string): void {
  const slug = value as string;
  if (slugs.has(slug)) throw new PublicContractError(`${label} slug must be unique: ${slug}`);
  slugs.add(slug);
}

function assertPublicSlugWithContract(value: unknown, label: string): asserts value is string {
  try {
    assertPublicSlug(value, label);
  } catch (error) {
    throw new PublicContractError(error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const FORBIDDEN_PUBLIC_FIELD_NAMES = new Set([
  "access_token",
  "account_username",
  "api_key",
  "artist_id",
  "authorization",
  "canonical_snapshot_sha256",
  "country",
  "credential",
  "database_state",
  "device",
  "device_id",
  "entity_id",
  "event_id",
  "event_timestamp",
  "events",
  "file_path",
  "filename",
  "fingerprint",
  "genre_evidence_snapshot_sha256",
  "genre_id",
  "input_file",
  "input_hash",
  "input_path",
  "ip_addr",
  "ip_address",
  "listening_event",
  "migration",
  "migrations",
  "password",
  "platform",
  "provider_entity_id",
  "raw_payload",
  "raw_provider_payload",
  "raw_record",
  "relative_path",
  "secret",
  "source_file",
  "source_id",
  "source_path",
  "source_record",
  "timestamp",
  "token",
  "track_id",
  "user_agent",
  "username",
]);

function assertNoForbiddenFields(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenFields(item, label);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key
      .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
      .replace(/[\s-]+/gu, "_")
      .toLowerCase();
    if (
      FORBIDDEN_PUBLIC_FIELD_NAMES.has(normalized) ||
      normalized.startsWith("raw_") ||
      normalized.endsWith("_fingerprint")
    ) {
      throw new PublicContractError(`${label} contains forbidden private field: ${key}`);
    }
    assertNoForbiddenFields(item, label);
  }
}
