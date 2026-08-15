import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ANALYTICAL_EXPORT_ARTIFACT_SCHEMA_VERSION,
  ANALYTICAL_EXPORT_SCHEMA_VERSION,
  type AnalyticalExportArtifact,
  type AnalyticalExportArtifactName,
  type AnalyticalExportDatabaseState,
  type AnalyticalExportManifest,
} from "../../src/exports/analytics.ts";
import {
  dormancySelectionKey,
  PUBLICATION_INPUT_SCHEMA_VERSION,
  type PublicationContentInput,
  type PublicationProjectionInput,
  rediscoverySelectionKey,
} from "../../src/publication/projection.ts";

const names = [
  "abandonment",
  "artist-eras",
  "coverage",
  "genre-eras",
  "rediscovery",
  "volume",
] as const satisfies readonly AnalyticalExportArtifactName[];

export const syntheticDatabaseState: AnalyticalExportDatabaseState = {
  canonicalSnapshotSha256: "1".repeat(64),
  genreEvidenceSnapshotSha256: "2".repeat(64),
  migrations: [{ checksumSha256: "3".repeat(64), name: "synthetic", version: 1 }],
};

const start = "2020-01-01T06:00:00.000Z";
const end = "2021-01-01T06:00:00.000Z";

const commonEnvelope = {
  asOf: end,
  dateRange: { endExclusive: end, startInclusive: start },
  eventCount: 50,
  includedSources: ["lastfm", "spotify"],
  presentationTimezone: "America/Chicago",
  schemaVersion: "analytical-result-v2",
  unresolvedRate: 0.1,
} as const;

const artistComponents = {
  consecutiveActiveWindows: 4,
  earlierBaselineChange: 20,
  earlierBaselineRollingPlayCount: 4,
  isQualified: true,
  listeningShare: 0.8,
  rank: 1,
  rollingPlayCount: 24,
  strength: 0.75,
  windowPlayCount: 6,
} as const;

export const syntheticRediscovery = {
  classification: "sustained_rediscovery",
  entityDisplayName: "Synthetic Eligible Artist",
  entityId: 1,
  gapDays: 425,
  persistence: "persistent",
  persistencePlayCount: 4,
  priorListenAt: "2019-01-15T18:00:00.000Z",
  priorPlayCount: 8,
  relatedEra: { windowEndExclusive: "2020-05", windowStart: "2020-01" },
  returnIntensity: 5,
  returnStartedAt: "2020-03-15T18:00:00.000Z",
  returnWindowComplete: true,
  scope: "artist",
} as const;

export const syntheticDormancy = {
  activePeriodCount: 2,
  artistDisplayName: "Synthetic Dormant Artist",
  artistId: 2,
  confidence: {
    formerCadence: 0.8,
    historicalImportance: 0.8,
    observationCompleteness: 1,
    score: 0.8666666666666667,
  },
  formerCadencePlayCount: 5,
  formerCadencePlaysPer30Days: 0.8333333333333334,
  historicalPlayCount: 10,
  lastActivePeriod: {
    endAt: "2018-06-30T23:59:59.999Z",
    playCount: 5,
    startAt: "2018-01-01T06:00:00.000Z",
  },
  lastListenAt: "2018-06-30T23:59:59.999Z",
  observationDays: 915.25,
  status: "likely_abandoned_as_of",
} as const;

export function createSyntheticPrivateArtifacts(options: { readonly empty?: boolean } = {}) {
  const empty = options.empty ?? false;
  const eventCount = empty ? 0 : 50;
  const context = {
    ...commonEnvelope,
    asOf: empty ? null : commonEnvelope.asOf,
    dateRange: empty ? null : commonEnvelope.dateRange,
    eventCount,
    unresolvedRate: empty ? 0 : commonEnvelope.unresolvedRate,
  };
  const envelope = (
    analysis: string,
    definition: string,
    parameters: Record<string, unknown>,
    result: Record<string, unknown>,
    versions: {
      readonly analysis: string;
      readonly parameterSchema: string;
      readonly query: string;
    },
    metadataCoverage: Record<string, unknown> = {},
  ) => ({
    ...context,
    analysis,
    definition,
    metadataCoverage,
    parameters,
    result,
    versions: {
      ...versions,
      identityRules: ["synthetic-v1"],
      reconciliationRules: ["synthetic-v1"],
    },
  });
  const volumeRows = empty
    ? []
    : Array.from({ length: 12 }, (_, index) => {
        const playCount = index < 2 ? 5 : 4;
        return {
          period: `2020-${String(index + 1).padStart(2, "0")}`,
          priorYearValue: null,
          rollingValue: playCount,
          value: playCount,
          yearOverYearAbsoluteChange: null,
          yearOverYearRate: null,
        };
      });
  const artistIntervals = empty
    ? []
    : [
        artistInterval(1, "Synthetic Eligible Artist", 24, 0.75, 0.6),
        artistInterval(3, "Synthetic Count Suppressed Artist", 23, 1, 0.1),
        artistInterval(4, "Synthetic Strength Suppressed Artist", 24, 0.749, 0.1),
        artistInterval(5, "Synthetic Overlap Artist", 24, 0.8, 0.4, [12, 12]),
      ];
  const data = {
    volume: envelope(
      "listening-volume",
      "Counts every canonical track event once.",
      {
        endExclusive: null,
        grain: "month",
        includeUnresolved: true,
        metric: "play_count",
        minimumDurationMs: 30_000,
        rollingWindowPeriods: 1,
        startInclusive: null,
      },
      { metricLabel: "Canonical plays", rows: volumeRows, totalValue: eventCount },
      {
        analysis: "listening-volume-v1",
        parameterSchema: "listening-volume-parameters-v1",
        query: "canonical-volume-v1",
      },
      {
        spotifyDuration: {
          availableEventCount: empty ? 0 : 30,
          rate: empty ? 0 : 0.6,
          totalEventCount: eventCount,
        },
      },
    ),
    "artist-eras": envelope(
      "artist-eras",
      "Synthetic artist eras.",
      {
        maximumRank: 20,
        minimumConsecutiveActiveWindows: 2,
        minimumEarlierBaselineChange: -12,
        minimumListeningShare: 0.02,
        minimumRollingPlayCount: 12,
        minimumWindowPlayCount: 3,
        rollingWindowCount: 4,
        windowSizeMonths: 3,
      },
      { intervals: artistIntervals },
      {
        analysis: "artist-era-v1",
        parameterSchema: "artist-era-parameters-v1",
        query: "canonical-artist-era-v1",
      },
    ),
    rediscovery: envelope(
      "rediscovery",
      "Synthetic rediscoveries.",
      {
        absenceThresholdDays: 180,
        minimumPersistencePlayCount: 2,
        minimumPriorPlayCount: 5,
        minimumReturnPlayCount: 1,
        persistenceWindowDays: 90,
        returnWindowDays: 30,
        scope: "artist",
      },
      { rediscoveries: empty ? [] : [syntheticRediscovery] },
      {
        analysis: "rediscovery-v1",
        parameterSchema: "rediscovery-parameters-v1",
        query: "canonical-rediscovery-v1",
      },
    ),
    abandonment: envelope(
      "abandonment",
      "Synthetic dormancy observations.",
      {
        activePeriodGapDays: 90,
        asOf: null,
        dormancyDays: 180,
        formerCadenceWindowDays: 180,
        likelyAbandonedDays: 365,
        minimumFormerCadencePlayCount: 3,
        minimumHistoricalPlayCount: 5,
        observationWindowDays: 365,
      },
      { artists: empty ? [] : [syntheticDormancy] },
      {
        analysis: "abandonment-v1",
        parameterSchema: "abandonment-parameters-v1",
        query: "canonical-abandonment-v1",
      },
    ),
    "genre-eras": envelope(
      "genre-eras",
      "Synthetic genre eras.",
      {
        maximumRank: 20,
        minimumConsecutiveActiveWindows: 2,
        minimumEarlierBaselineChange: -12,
        minimumListeningShare: 0.02,
        minimumRollingContribution: 12,
        minimumWindowContribution: 3,
        rollingWindowCount: 4,
        windowSizeMonths: 3,
      },
      {
        contributionVersion: "genre-contribution-v2",
        coverage: {
          missing: { artistCount: empty ? 0 : 1, eventCount },
          total: { artistCount: empty ? 0 : 1, eventCount },
          usable: { artistCount: 0, eventCount: 0 },
        },
        fetchAge: {
          evaluatedAtEpochMs: 0,
          fresh: { artistCount: 0, eventCount: 0 },
          refreshAgeMs: 15_552_000_000,
          stale: { artistCount: 0, eventCount: 0 },
        },
        intervals: [],
        mode: "raw",
        provider: "musicbrainz",
        taxonomyVersion: null,
        weightingLevel: "artist",
      },
      {
        analysis: "genre-era-v2",
        parameterSchema: "genre-era-parameters-v1",
        query: "canonical-genre-era-v2",
      },
    ),
    coverage: syntheticCoverage(empty),
  } as const;
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        artifact: name,
        databaseState: syntheticDatabaseState,
        data: data[name],
        schemaVersion: ANALYTICAL_EXPORT_ARTIFACT_SCHEMA_VERSION,
      },
    ]),
  ) as unknown as Readonly<Record<AnalyticalExportArtifactName, AnalyticalExportArtifact>>;
}

export function writeSyntheticPrivateBundle(
  directory: string,
  options: { readonly empty?: boolean } = {},
): AnalyticalExportManifest {
  mkdirSync(directory, { recursive: true });
  const artifacts = createSyntheticPrivateArtifacts(options);
  const descriptors = Object.fromEntries(
    names.map((name) => {
      const bytes = serialize(artifacts[name]);
      writeFileSync(path.join(directory, `${name}.json`), bytes, "utf8");
      return [name, { file: `${name}.json`, sha256: digest(bytes) }];
    }),
  ) as AnalyticalExportManifest["artifacts"];
  const manifest: AnalyticalExportManifest = {
    artifacts: descriptors,
    databaseState: syntheticDatabaseState,
    schemaVersion: ANALYTICAL_EXPORT_SCHEMA_VERSION,
  };
  writeFileSync(path.join(directory, "manifest.json"), serialize(manifest), "utf8");
  return manifest;
}

export function syntheticPublicationInput(
  snapshotId = "snapshot-2026-08-09-fixture",
): PublicationProjectionInput {
  return {
    annotations: [
      {
        ...content("synthetic-annotation", 1),
        period: "2020-03",
        route: "/history/",
      },
    ],
    artistSelections: [
      {
        artistDisplayName: "Synthetic Eligible Artist",
        artistId: 1,
        slug: "synthetic-eligible-artist",
      },
      {
        artistDisplayName: "Synthetic Overlap Artist",
        artistId: 5,
        slug: "synthetic-overlap-artist",
      },
    ],
    featuredArtists: [
      {
        ...content("synthetic-feature", 1),
        artistSlug: "synthetic-eligible-artist",
        storySlugs: ["synthetic-rediscovery"],
      },
    ],
    schemaVersion: PUBLICATION_INPUT_SCHEMA_VERSION,
    selectedTracks: [
      {
        artistDisplayName: "Wholly Manual Track Artist",
        storySlug: "synthetic-rediscovery",
        trackDisplayName: "Wholly Manual Selected Track",
        trackSlug: "wholly-manual-selected-track",
      },
    ],
    snapshotId,
    stories: [
      {
        ...content("synthetic-rediscovery", 1),
        artistSlug: "synthetic-eligible-artist",
        kind: "rediscovery",
        selectionKey: rediscoverySelectionKey(syntheticRediscovery),
        supersedesStorySlug: null,
      },
      {
        ...content("synthetic-dormancy", 2),
        artistSlug: null,
        kind: "dormancy",
        selectionKey: dormancySelectionKey(syntheticDormancy),
        supersedesStorySlug: null,
      },
    ],
  };
}

export function emptyPublicationInput(
  snapshotId = "snapshot-2026-08-09-empty",
): PublicationProjectionInput {
  return {
    annotations: [],
    artistSelections: [],
    featuredArtists: [],
    schemaVersion: PUBLICATION_INPUT_SCHEMA_VERSION,
    selectedTracks: [],
    snapshotId,
    stories: [],
  };
}

function artistInterval(
  artistId: number,
  artistDisplayName: string,
  playCount: number,
  strength: number,
  share: number,
  windowPlayCounts: readonly number[] = [6, 6, 6, playCount - 18],
) {
  const evidence = windowPlayCounts.map((windowPlayCount, index) => ({
    components: {
      ...artistComponents,
      listeningShare: share,
      rollingPlayCount: playCount,
      strength,
      windowPlayCount,
    },
    windowEndExclusive: `2020-${String(index + 2).padStart(2, "0")}`,
    windowStart: `2020-${String(index + 1).padStart(2, "0")}`,
  }));
  const peak = evidence[0];
  if (peak === undefined) throw new Error("Synthetic artist interval requires evidence");
  return {
    artistDisplayName,
    artistId,
    evidence,
    peak: { components: peak.components, windowStart: peak.windowStart },
    playCount,
    share,
    strength,
    windowEndExclusive: `2020-${String(windowPlayCounts.length + 1).padStart(2, "0")}`,
    windowStart: "2020-01",
  };
}

function syntheticCoverage(empty: boolean) {
  const eventCount = empty ? 0 : 50;
  return {
    canonical: {
      bySourceBacking: {
        both: empty ? 0 : 10,
        lastfm: empty ? 0 : 20,
        spotify: empty ? 0 : 20,
      },
      eventCount,
      merges: {
        exactDuplicateEvents: 0,
        exactDuplicateSourceLinks: 0,
        inferredCrossSourceEvents: empty ? 0 : 10,
        inferredCrossSourceSourceLinks: empty ? 0 : 20,
      },
      overlapByYear: empty ? [] : [{ eventCount: 10, year: 2020 }],
      unresolved: { eventCount: empty ? 0 : 5, rate: empty ? 0 : 0.1 },
    },
    inputFiles: [{ sha256: "4".repeat(64), source: "lastfm" }],
    reportVersion: "coverage-v2",
    semantics: {
      canonicalEventCountsIncluded: true,
      countLayer: "source_evidence_occurrences",
      longGapDefinition: "Synthetic gap definition.",
      longGapThresholdDays: 365,
    },
    sources: (["lastfm", "spotify"] as const).map((source) => ({
      byYear: empty ? [] : [{ evidenceCount: 30, year: 2020 }],
      duplicates: { extraEvidenceCount: 0, groupCount: 0 },
      evidenceCount: empty ? 0 : 30,
      longGaps: empty
        ? []
        : [
            {
              after: "2020-03-01T06:00:00.000Z",
              before: "2021-03-01T06:00:00.000Z",
              durationDays: 365,
            },
          ],
      missingFields: (source === "spotify"
        ? ["albumName", "reasonStart", "reasonEnd", "skipped", "offline", "offlineAt"]
        : [
            "albumName",
            "artistMusicBrainzId",
            "releaseMusicBrainzId",
            "recordingMusicBrainzId",
            "loved",
          ]
      ).map((field) => ({
        field,
        missingCount: 0,
        missingRate: 0,
        totalCount: empty ? 0 : 30,
      })),
      observedRange: empty
        ? null
        : {
            firstObservedAt: start,
            lastObservedAt: "2020-12-31T23:59:59.999Z",
          },
      source,
      totals: { accepted: empty ? 0 : 30, nonMusic: 0, rejected: 0 },
    })),
    timezone: "America/Chicago",
    totals: {
      accepted: empty ? 0 : 60,
      canonicalEvents: eventCount,
      evidenceOccurrences: empty ? 0 : 60,
      nonMusic: 0,
      rejected: 0,
    },
  };
}

function content(slug: string, order: number): PublicationContentInput {
  return {
    accessibilitySummary: `Accessible summary for ${slug}.`,
    body: [{ heading: null, paragraphs: [`Synthetic public prose for ${slug}.`] }],
    contentSchemaVersion: "public-content-v1",
    order,
    publicReferences: [],
    publicationStatus: "published",
    slug,
    summary: `Summary for ${slug}.`,
    title: `Title for ${slug}`,
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortJson(object[key])]),
    );
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
