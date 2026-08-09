import type { AbandonmentRecord } from "../analytics/abandonment.ts";
import type { ArtistEraInterval } from "../analytics/artist-eras.ts";
import type { RediscoveryRecord } from "../analytics/rediscovery.ts";
import type { JsonObject } from "../cli/result.ts";
import {
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  PUBLIC_GENERATION_VERSION,
  PublicContractError,
  validatePublicArtifact,
  type PublicAnalyticalVersion,
  type PublicArtifactEnvelope,
  type PublicArtifactName,
  type PublicCoverageSummary,
} from "./contract.ts";
import type { LoadedPrivateAnalyticalBundle } from "./private-bundle.ts";
import {
  PUBLIC_SELECTION_POLICY,
  PUBLIC_SELECTION_POLICY_VERSION,
  PublicationPolicyError,
  assertPublicSlug,
  reduceAnalyticalTimestampToMonth,
  reduceOperationalTimestampToDate,
  selectEditorialTrackDetails,
  selectEligiblePublicArtists,
  type SelectedTrackAllowlistEntry,
} from "./policy.ts";

export const PUBLICATION_INPUT_SCHEMA_VERSION = "publication-input-v1";

export interface PublicationContentInput {
  readonly accessibilitySummary: string;
  readonly body: readonly {
    readonly heading: string | null;
    readonly paragraphs: readonly string[];
  }[];
  readonly contentSchemaVersion: "public-content-v1";
  readonly order: number;
  readonly publicReferences: readonly string[];
  readonly publicationStatus: "published";
  readonly slug: string;
  readonly summary: string;
  readonly title: string;
}

export interface PublicationProjectionInput {
  readonly annotations: readonly (PublicationContentInput & {
    readonly period: string | null;
    readonly route: string;
  })[];
  readonly artistSelections: readonly {
    readonly artistDisplayName: string;
    readonly artistId: number;
    readonly slug: string;
  }[];
  readonly featuredArtists: readonly (PublicationContentInput & {
    readonly artistSlug: string;
    readonly storySlugs: readonly string[];
  })[];
  readonly schemaVersion: typeof PUBLICATION_INPUT_SCHEMA_VERSION;
  readonly selectedTracks: readonly SelectedTrackAllowlistEntry[];
  readonly snapshotId: string;
  readonly stories: readonly (PublicationContentInput & {
    readonly artistSlug: string | null;
    readonly kind: "dormancy" | "rediscovery";
    readonly selectionKey: string;
    readonly supersedesStorySlug: string | null;
  })[];
}

export interface ProjectedPublicSnapshot {
  readonly analyticalVersions: readonly PublicAnalyticalVersion[];
  readonly artifacts: Readonly<
    Record<
      Exclude<PublicArtifactName, "genre-lab">,
      PublicArtifactEnvelope<PublicArtifactName, unknown>
    >
  >;
  readonly asOfDate: string | null;
  readonly coverage: PublicCoverageSummary;
  readonly snapshotId: string;
  readonly timezone: string;
}

export class PublicationProjectionError extends Error {
  readonly code:
    | "incompatible_private_artifact"
    | "invalid_editorial_input"
    | "stale_editorial_selection";

  constructor(code: PublicationProjectionError["code"], message: string) {
    super(message);
    this.name = "PublicationProjectionError";
    this.code = code;
  }
}

export function rediscoverySelectionKey(record: RediscoveryRecord): string {
  return `rediscovery:${record.scope}:${record.entityId}:${record.returnStartedAt}`;
}

export function dormancySelectionKey(record: AbandonmentRecord): string {
  return `dormancy:${record.artistId}:${record.lastListenAt}`;
}

/** Projects new closed objects field-by-field; private objects are never spread across boundary. */
export function projectPublicSnapshot(
  bundle: LoadedPrivateAnalyticalBundle,
  input: PublicationProjectionInput,
): ProjectedPublicSnapshot {
  try {
    validateProjectionInput(input);
    const artistSelections = uniqueArtistSelections(input.artistSelections);
    const timezone = bundle.volume.presentationTimezone;
    const coverage = projectCoverage(bundle);
    const asOfDate =
      bundle.volume.asOf === null ? null : reduceOperationalTimestampToDate(bundle.volume.asOf);
    const analyticalVersions = projectAnalyticalVersions(bundle);
    const common = {
      analyticalVersions,
      asOfDate,
      coverage,
      generationVersion: PUBLIC_GENERATION_VERSION,
      publicationDate: null,
      schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
      selectionPolicyVersion: PUBLIC_SELECTION_POLICY_VERSION,
      snapshotId: input.snapshotId,
      timezone,
    } as const;

    const history = publicArtifact({
      ...common,
      artifact: "history",
      data: projectHistory(bundle),
    });
    const artists = publicArtifact({
      ...common,
      artifact: "artists",
      data: projectArtists(bundle, artistSelections),
    });
    const eligibleSlugs = new Set(
      (artists.data as { readonly artists: readonly { readonly slug: string }[] }).artists.map(
        (artist) => artist.slug,
      ),
    );
    const stories = publicArtifact({
      ...common,
      artifact: "stories",
      data: projectStories(bundle, input, eligibleSlugs, artistSelections),
    });
    const storySlugs = new Set(
      (stories.data as { readonly stories: readonly { readonly slug: string }[] }).stories.map(
        (story) => story.slug,
      ),
    );
    const editorial = publicArtifact({
      ...common,
      artifact: "editorial",
      data: projectEditorial(input, eligibleSlugs, storySlugs),
    });

    return {
      analyticalVersions,
      artifacts: { artists, editorial, history, stories },
      asOfDate,
      coverage,
      snapshotId: input.snapshotId,
      timezone,
    };
  } catch (error) {
    if (error instanceof PublicationProjectionError) throw error;
    if (error instanceof PublicationPolicyError || error instanceof PublicContractError) {
      throw new PublicationProjectionError("invalid_editorial_input", error.message);
    }
    throw new PublicationProjectionError(
      "incompatible_private_artifact",
      "Private analytical data is incompatible with the public projection",
    );
  }
}

function projectCoverage(bundle: LoadedPrivateAnalyticalBundle): PublicCoverageSummary {
  const volume = bundle.volume;
  const spotifyDuration = volume.metadataCoverage.spotifyDuration;
  if (spotifyDuration === undefined) incompatible();
  return {
    canonicalEventCount: volume.eventCount,
    dateRange:
      volume.dateRange === null
        ? null
        : {
            endPeriodExclusive: monthAfterInstant(
              volume.dateRange.endExclusive,
              volume.presentationTimezone,
            ),
            startPeriod: reduceAnalyticalTimestampToMonth(
              volume.dateRange.startInclusive,
              volume.presentationTimezone,
            ),
          },
    includedSources: volume.includedSources,
    spotifyDurationEventCount: spotifyDuration.availableEventCount,
    unresolvedRate: volume.unresolvedRate,
  };
}

function projectAnalyticalVersions(
  bundle: LoadedPrivateAnalyticalBundle,
): readonly PublicAnalyticalVersion[] {
  return [bundle.abandonment, bundle.artistEras, bundle.volume, bundle.rediscovery]
    .map((analysis) => ({
      analysis: analysis.analysis,
      analysisVersion: analysis.versions.analysis,
      parameterSchemaVersion: analysis.versions.parameterSchema,
      queryVersion: analysis.versions.query,
    }))
    .toSorted((left, right) => compareText(left.analysis, right.analysis));
}

function projectHistory(bundle: LoadedPrivateAnalyticalBundle): JsonObject {
  const volume = bundle.volume;
  const parameters = volume.parameters;
  const result = volume.result;
  if (
    parameters.metric !== "play_count" ||
    parameters.grain !== "month" ||
    parameters.startInclusive !== null ||
    parameters.endExclusive !== null ||
    typeof parameters.includeUnresolved !== "boolean" ||
    !isPositiveInteger(parameters.rollingWindowPeriods) ||
    result.rows.length > PUBLIC_SELECTION_POLICY.resultLimits.maximumHistoryMonths
  ) {
    incompatible();
  }
  const coverage = bundle.coverage;
  const sources = coverage.sources
    .map((source) => ({
      byYear: source.byYear.map((row) => ({
        evidenceCount: row.evidenceCount,
        period: String(row.year),
      })),
      longGaps: source.longGaps.map((gap) => ({
        afterPeriod: reduceAnalyticalTimestampToMonth(gap.after, volume.presentationTimezone),
        beforePeriod: reduceAnalyticalTimestampToMonth(gap.before, volume.presentationTimezone),
        durationDays: gap.durationDays,
      })),
      observedEndPeriod:
        source.observedRange === null
          ? null
          : reduceAnalyticalTimestampToMonth(
              source.observedRange.lastObservedAt,
              volume.presentationTimezone,
            ),
      observedStartPeriod:
        source.observedRange === null
          ? null
          : reduceAnalyticalTimestampToMonth(
              source.observedRange.firstObservedAt,
              volume.presentationTimezone,
            ),
      source: source.source,
    }))
    .toSorted((left, right) => compareText(left.source, right.source));
  const periods = result.rows.map((row) => ({
    period: row.period,
    playCount: row.value,
    priorYearPlayCount: row.priorYearValue,
    rollingPlayCount: row.rollingValue,
    yearOverYearAbsoluteChange: row.yearOverYearAbsoluteChange,
    yearOverYearRate: row.yearOverYearRate,
  }));
  if (periods.some((row) => !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(row.period))) incompatible();
  return {
    canonicalSourceBacking: {
      both: coverage.canonical.bySourceBacking.both,
      lastfm: coverage.canonical.bySourceBacking.lastfm,
      spotify: coverage.canonical.bySourceBacking.spotify,
    },
    grain: "month",
    metric: "play_count",
    metricDefinition: volume.definition,
    overlapByYear: coverage.canonical.overlapByYear.map((row) => ({
      eventCount: row.eventCount,
      period: String(row.year),
    })),
    parameters: {
      includeUnresolved: parameters.includeUnresolved,
      rollingWindowPeriods: parameters.rollingWindowPeriods,
    },
    periods,
    sourceCoverage: sources,
    totalPlayCount: result.totalValue,
  };
}

function projectArtists(
  bundle: LoadedPrivateAnalyticalBundle,
  selections: ReturnType<typeof uniqueArtistSelections>,
): JsonObject {
  const grouped = new Map<number, { displayName: string; intervals: ArtistEraInterval[] }>();
  for (const interval of bundle.artistEras.result.intervals) {
    const existing = grouped.get(interval.artistId);
    if (existing !== undefined && existing.displayName !== interval.artistDisplayName)
      incompatible();
    const group = existing ?? { displayName: interval.artistDisplayName, intervals: [] };
    group.intervals.push(interval);
    grouped.set(interval.artistId, group);
  }

  const candidates = [...grouped.entries()]
    .filter(([, group]) =>
      group.intervals.some(
        (interval) =>
          interval.playCount >=
            PUBLIC_SELECTION_POLICY.artistEligibility.minimumQualifyingIntervalPlayCount &&
          interval.strength >= PUBLIC_SELECTION_POLICY.artistEligibility.minimumPeakStrength,
      ),
    )
    .map(([artistId, group]) => {
      const selection = selections.get(artistId);
      if (selection === undefined || selection.artistDisplayName !== group.displayName) {
        throw new PublicationProjectionError(
          "stale_editorial_selection",
          "An eligible artist does not resolve through a reviewed public slug selection",
        );
      }
      return {
        displayName: group.displayName,
        intervals: group.intervals.map((interval) => ({
          playCount: interval.playCount,
          strength: interval.strength,
        })),
        slug: selection.slug,
      };
    });
  const selected = selectEligiblePublicArtists(candidates);
  const selectedSlugs = new Set(selected.map((candidate) => candidate.slug));
  const artists = [...selections.values()]
    .filter((selection) => selectedSlugs.has(selection.slug))
    .map((selection) => {
      const group = grouped.get(selection.artistId);
      if (group === undefined) incompatible();
      const intervals = group.intervals
        .toSorted((left, right) => {
          if (left.playCount !== right.playCount) return right.playCount - left.playCount;
          if (left.strength !== right.strength) return right.strength - left.strength;
          return compareText(left.windowStart, right.windowStart);
        })
        .slice(0, PUBLIC_SELECTION_POLICY.artistEligibility.maximumIntervalsPerArtist)
        .map((interval) => projectArtistInterval(interval))
        .toSorted((left, right) => compareText(left.startPeriod, right.startPeriod));
      return { displayName: group.displayName, intervals, slug: selection.slug };
    })
    .toSorted((left, right) => compareText(left.slug, right.slug));

  return {
    artists,
    parameters: projectExactParameters(bundle.artistEras.parameters, [
      "maximumRank",
      "minimumConsecutiveActiveWindows",
      "minimumEarlierBaselineChange",
      "minimumListeningShare",
      "minimumRollingPlayCount",
      "minimumWindowPlayCount",
      "rollingWindowCount",
      "windowSizeMonths",
    ]),
  } as unknown as JsonObject;
}

function projectArtistInterval(interval: ArtistEraInterval) {
  const maximumEvidence =
    PUBLIC_SELECTION_POLICY.artistEligibility.maximumEvidenceWindowsPerInterval;
  const peakIndex = interval.evidence.findIndex(
    (item) => item.windowStart === interval.peak.windowStart,
  );
  if (peakIndex < 0) incompatible();
  const sliceStart = Math.min(
    Math.max(peakIndex - Math.floor(maximumEvidence / 2), 0),
    Math.max(interval.evidence.length - maximumEvidence, 0),
  );
  const sourceEvidence = interval.evidence.slice(sliceStart, sliceStart + maximumEvidence);
  const firstEvidence = sourceEvidence[0];
  const lastEvidence = sourceEvidence.at(-1);
  if (firstEvidence === undefined || lastEvidence === undefined) incompatible();
  const evidence = sourceEvidence.map((item) => ({
    components: projectArtistComponents(item.components),
    period: item.windowStart,
  }));
  const wasBounded = sourceEvidence.length !== interval.evidence.length;
  return {
    endPeriodExclusive: wasBounded ? lastEvidence.windowEndExclusive : interval.windowEndExclusive,
    evidence,
    peak: {
      components: projectArtistComponents(interval.peak.components),
      period: interval.peak.windowStart,
    },
    playCount: wasBounded
      ? sourceEvidence.reduce((sum, item) => sum + item.components.windowPlayCount, 0)
      : interval.playCount,
    share: wasBounded
      ? sourceEvidence.reduce((sum, item) => sum + item.components.listeningShare, 0) /
        sourceEvidence.length
      : interval.share,
    startPeriod: wasBounded ? firstEvidence.windowStart : interval.windowStart,
    strength: interval.strength,
  };
}

function projectArtistComponents(components: Record<string, unknown>): JsonObject {
  return projectExactParameters(components, [
    "consecutiveActiveWindows",
    "earlierBaselineChange",
    "earlierBaselineRollingPlayCount",
    "listeningShare",
    "rank",
    "rollingPlayCount",
    "strength",
    "windowPlayCount",
  ]);
}

function projectStories(
  bundle: LoadedPrivateAnalyticalBundle,
  input: PublicationProjectionInput,
  eligibleSlugs: ReadonlySet<string>,
  artistSelections: ReturnType<typeof uniqueArtistSelections>,
): JsonObject {
  if (input.stories.length > PUBLIC_SELECTION_POLICY.resultLimits.maximumStories) {
    invalidEditorial("Story result limit exceeded");
  }
  const rediscoveries = uniqueCandidates(
    bundle.rediscovery.result.rediscoveries.map(
      (record) => [rediscoverySelectionKey(record), record] as const,
    ),
  );
  const dormancies = uniqueCandidates(
    bundle.abandonment.result.artists.map(
      (record) => [dormancySelectionKey(record), record] as const,
    ),
  );
  const selectedTracks = selectEditorialTrackDetails(input.selectedTracks);
  const tracksByStory = new Map(selectedTracks.map((track) => [track.storySlug, track]));
  const authoredSlugs = new Set(input.stories.map((story) => story.slug));
  for (const track of selectedTracks) {
    if (!authoredSlugs.has(track.storySlug)) {
      throw new PublicationProjectionError(
        "stale_editorial_selection",
        "A manual selected track references a missing story",
      );
    }
  }
  const usedSelections = new Set<string>();
  const stories = input.stories
    .map((story) => {
      if (usedSelections.has(story.selectionKey)) {
        invalidEditorial("A private analytical selection may belong to only one public story");
      }
      usedSelections.add(story.selectionKey);
      if (story.artistSlug !== null && !eligibleSlugs.has(story.artistSlug)) {
        throw new PublicationProjectionError(
          "stale_editorial_selection",
          "A story artist reference is not eligible in this snapshot",
        );
      }
      if (
        story.supersedesStorySlug !== null &&
        (story.supersedesStorySlug === story.slug || !authoredSlugs.has(story.supersedesStorySlug))
      ) {
        throw new PublicationProjectionError(
          "stale_editorial_selection",
          "A story supersession reference does not resolve in this snapshot",
        );
      }
      const selectedTrack = tracksByStory.get(story.slug) ?? null;
      if (story.kind === "rediscovery") {
        const record = rediscoveries.get(story.selectionKey);
        if (
          record === undefined ||
          record.scope !== "artist" ||
          bundle.rediscovery.parameters.scope !== "artist"
        ) {
          staleStory();
        }
        validateStoryArtistBinding(story.artistSlug, record.entityId, artistSelections);
        return {
          ...projectContent(story),
          artistSlug: story.artistSlug,
          evidence: {
            classification: record.classification,
            gapDays: record.gapDays,
            persistence: record.persistence,
            persistencePlayCount: record.persistencePlayCount,
            priorPeriod: reduceAnalyticalTimestampToMonth(
              record.priorListenAt,
              bundle.volume.presentationTimezone,
            ),
            priorPlayCount: record.priorPlayCount,
            relatedEra:
              record.relatedEra === null
                ? null
                : {
                    endPeriodExclusive: record.relatedEra.windowEndExclusive,
                    startPeriod: record.relatedEra.windowStart,
                  },
            returnIntensity: record.returnIntensity,
            returnPeriod: reduceAnalyticalTimestampToMonth(
              record.returnStartedAt,
              bundle.volume.presentationTimezone,
            ),
            returnWindowComplete: record.returnWindowComplete,
          },
          kind: "rediscovery",
          parameters: projectExactParameters(bundle.rediscovery.parameters, [
            "absenceThresholdDays",
            "minimumPersistencePlayCount",
            "minimumPriorPlayCount",
            "minimumReturnPlayCount",
            "persistenceWindowDays",
            "returnWindowDays",
            "scope",
          ]),
          selectedTrack,
          supersedesStorySlug: story.supersedesStorySlug,
        };
      }
      const record = dormancies.get(story.selectionKey);
      if (record === undefined) staleStory();
      validateStoryArtistBinding(story.artistSlug, record.artistId, artistSelections);
      return {
        ...projectContent(story),
        artistSlug: story.artistSlug,
        evidence: {
          activePeriodCount: record.activePeriodCount,
          confidence: {
            formerCadence: record.confidence.formerCadence,
            historicalImportance: record.confidence.historicalImportance,
            observationCompleteness: record.confidence.observationCompleteness,
            score: record.confidence.score,
          },
          formerCadencePlayCount: record.formerCadencePlayCount,
          formerCadencePlaysPer30Days: record.formerCadencePlaysPer30Days,
          historicalPlayCount: record.historicalPlayCount,
          lastActivePeriod: {
            endPeriod: reduceAnalyticalTimestampToMonth(
              record.lastActivePeriod.endAt,
              bundle.volume.presentationTimezone,
            ),
            playCount: record.lastActivePeriod.playCount,
            startPeriod: reduceAnalyticalTimestampToMonth(
              record.lastActivePeriod.startAt,
              bundle.volume.presentationTimezone,
            ),
          },
          lastListenPeriod: reduceAnalyticalTimestampToMonth(
            record.lastListenAt,
            bundle.volume.presentationTimezone,
          ),
          observationDays: record.observationDays,
          status: record.status,
        },
        kind: "dormancy",
        parameters: projectExactParameters(bundle.abandonment.parameters, [
          "activePeriodGapDays",
          "dormancyDays",
          "formerCadenceWindowDays",
          "likelyAbandonedDays",
          "minimumFormerCadencePlayCount",
          "minimumHistoricalPlayCount",
          "observationWindowDays",
        ]),
        selectedTrack,
        supersedesStorySlug: story.supersedesStorySlug,
      };
    })
    .toSorted(compareContentOrder);
  return { stories } as unknown as JsonObject;
}

function validateStoryArtistBinding(
  storyArtistSlug: string | null,
  analyticalArtistId: number,
  artistSelections: ReturnType<typeof uniqueArtistSelections>,
): void {
  if (storyArtistSlug === null) return;
  if (artistSelections.get(analyticalArtistId)?.slug !== storyArtistSlug) {
    throw new PublicationProjectionError(
      "stale_editorial_selection",
      "A story artist reference does not match its analytical evidence",
    );
  }
}

function projectEditorial(
  input: PublicationProjectionInput,
  eligibleSlugs: ReadonlySet<string>,
  storySlugs: ReadonlySet<string>,
): JsonObject {
  if (
    input.annotations.length > PUBLIC_SELECTION_POLICY.resultLimits.maximumAnnotations ||
    input.featuredArtists.length > PUBLIC_SELECTION_POLICY.resultLimits.maximumFeaturedArtists
  ) {
    invalidEditorial("Editorial input exceeds its public result limit");
  }
  const annotations = input.annotations
    .map((annotation) => ({
      ...projectContent(annotation),
      period: annotation.period,
      route: annotation.route,
    }))
    .toSorted(compareContentOrder);
  const featuredArtists = input.featuredArtists
    .map((featured) => {
      if (
        !eligibleSlugs.has(featured.artistSlug) ||
        featured.storySlugs.some((slug) => !storySlugs.has(slug))
      ) {
        throw new PublicationProjectionError(
          "stale_editorial_selection",
          "Featured editorial references do not resolve in this snapshot",
        );
      }
      return {
        ...projectContent(featured),
        artistSlug: featured.artistSlug,
        storySlugs: [...featured.storySlugs].toSorted(compareText),
      };
    })
    .toSorted(compareContentOrder);
  return { annotations, featuredArtists } as unknown as JsonObject;
}

function projectContent(content: PublicationContentInput) {
  return {
    accessibilitySummary: content.accessibilitySummary,
    body: content.body.map((section) => ({
      heading: section.heading,
      paragraphs: [...section.paragraphs],
    })),
    contentSchemaVersion: content.contentSchemaVersion,
    order: content.order,
    publicReferences: [...content.publicReferences],
    publicationStatus: content.publicationStatus,
    slug: content.slug,
    summary: content.summary,
    title: content.title,
  };
}

function validateProjectionInput(input: PublicationProjectionInput): void {
  if (!isPlainObject(input)) invalidEditorial("Publication input must be an object");
  exactKeys(input, [
    "annotations",
    "artistSelections",
    "featuredArtists",
    "schemaVersion",
    "selectedTracks",
    "snapshotId",
    "stories",
  ]);
  if (input.schemaVersion !== PUBLICATION_INPUT_SCHEMA_VERSION) {
    invalidEditorial("Publication input schema is incompatible");
  }
  assertSnapshotId(input.snapshotId);
  for (const collection of [
    input.annotations,
    input.artistSelections,
    input.featuredArtists,
    input.selectedTracks,
    input.stories,
  ]) {
    if (!Array.isArray(collection)) invalidEditorial("Publication selections must be arrays");
  }
  for (const annotation of input.annotations) {
    validateContentKeys(annotation, ["period", "route"]);
  }
  for (const featured of input.featuredArtists) {
    validateContentKeys(featured, ["artistSlug", "storySlugs"]);
  }
  for (const story of input.stories) {
    validateContentKeys(story, ["artistSlug", "kind", "selectionKey", "supersedesStorySlug"]);
  }
  for (const selection of input.artistSelections) {
    exactKeys(selection, ["artistDisplayName", "artistId", "slug"]);
  }
  for (const track of input.selectedTracks) {
    exactKeys(track, ["artistDisplayName", "storySlug", "trackDisplayName", "trackSlug"]);
  }
  const slugs = new Set<string>();
  for (const content of [...input.annotations, ...input.featuredArtists, ...input.stories]) {
    assertPublicSlug(content.slug, "Editorial slug");
    if (slugs.has(content.slug)) invalidEditorial("Editorial slugs must be globally unique");
    slugs.add(content.slug);
  }
}

const CONTENT_KEYS = [
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

function validateContentKeys(value: PublicationContentInput, additions: readonly string[]): void {
  exactKeys(value, [...CONTENT_KEYS, ...additions]);
}

function exactKeys(value: object, expectedKeys: readonly string[]): void {
  const expected = new Set(expectedKeys);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    invalidEditorial("Publication input contains an unknown or missing field");
  }
}

function uniqueArtistSelections(
  values: PublicationProjectionInput["artistSelections"],
): ReadonlyMap<number, PublicationProjectionInput["artistSelections"][number]> {
  const byId = new Map<number, PublicationProjectionInput["artistSelections"][number]>();
  const slugs = new Set<string>();
  for (const value of values) {
    assertPublicSlug(value.slug, "Artist slug");
    if (!Number.isSafeInteger(value.artistId) || value.artistId < 1 || byId.has(value.artistId)) {
      invalidEditorial("Artist selections must have unique private identities");
    }
    if (slugs.has(value.slug)) invalidEditorial("Artist selection slugs must be unique");
    slugs.add(value.slug);
    byId.set(value.artistId, value);
  }
  return byId;
}

function uniqueCandidates<T>(entries: readonly (readonly [string, T])[]): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const [key, value] of entries) {
    if (result.has(key)) {
      throw new PublicationProjectionError(
        "incompatible_private_artifact",
        "A private analytical selection key is ambiguous",
      );
    }
    result.set(key, value);
  }
  return result;
}

function projectExactParameters(
  source: Record<string, unknown>,
  keys: readonly string[],
): JsonObject {
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as JsonObject;
}

function publicArtifact<TName extends PublicArtifactName, TData>(
  artifact: PublicArtifactEnvelope<TName, TData>,
): PublicArtifactEnvelope<PublicArtifactName, unknown> {
  return validatePublicArtifact(artifact);
}

function monthAfterInstant(value: string, timezone: string): string {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) incompatible();
  const lastIncluded = new Date(epoch - 1).toISOString();
  const month = reduceAnalyticalTimestampToMonth(lastIncluded, timezone);
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber)) incompatible();
  return monthNumber === 12
    ? `${String(year + 1).padStart(4, "0")}-01`
    : `${yearText}-${String(monthNumber + 1).padStart(2, "0")}`;
}

function compareContentOrder(
  left: { readonly order: number; readonly slug: string },
  right: { readonly order: number; readonly slug: string },
): number {
  return left.order === right.order ? compareText(left.slug, right.slug) : left.order - right.order;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSnapshotId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^snapshot-\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  ) {
    invalidEditorial("Snapshot ID must be a stable public snapshot slug");
  }
}

function staleStory(): never {
  throw new PublicationProjectionError(
    "stale_editorial_selection",
    "A story does not resolve to exactly one current analytical candidate",
  );
}

function invalidEditorial(message: string): never {
  throw new PublicationProjectionError("invalid_editorial_input", message);
}

function incompatible(): never {
  throw new PublicationProjectionError(
    "incompatible_private_artifact",
    "Private analytical data is incompatible with the public projection",
  );
}
