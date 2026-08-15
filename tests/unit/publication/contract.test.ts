import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PUBLIC_ARTIFACT_FIELD_ALLOWLIST,
  PUBLIC_ARTIFACT_FILES,
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  PUBLIC_GENERATION_VERSION,
  PUBLIC_MANIFEST_SCHEMA_VERSION,
  PUBLIC_REVIEW_REPORT_SCHEMA_VERSION,
  PublicContractError,
  validatePublicArtifact,
  validatePublicManifest,
  validatePublicReviewReport,
} from "../../../src/publication/contract.ts";
import { PUBLIC_SELECTION_POLICY_VERSION } from "../../../src/publication/policy.ts";

const sha256 = "a".repeat(64);

const analyticalVersionContracts = {
  abandonment: ["abandonment-v1", "abandonment-parameters-v1", "canonical-abandonment-v1"],
  "artist-eras": ["artist-era-v1", "artist-era-parameters-v1", "canonical-artist-era-v1"],
  "genre-eras": ["genre-era-v2", "genre-era-parameters-v1", "canonical-genre-era-v2"],
  "listening-volume": [
    "listening-volume-v1",
    "listening-volume-parameters-v1",
    "canonical-volume-v1",
  ],
  rediscovery: ["rediscovery-v1", "rediscovery-parameters-v1", "canonical-rediscovery-v1"],
} as const;

type AnalysisName = keyof typeof analyticalVersionContracts;

function analyticalVersions(...analyses: readonly AnalysisName[]) {
  return analyses.map((analysis) => {
    const [analysisVersion, parameterSchemaVersion, queryVersion] =
      analyticalVersionContracts[analysis];
    return { analysis, analysisVersion, parameterSchemaVersion, queryVersion };
  });
}

function commonArtifact(artifact: string, data: unknown) {
  const requiredVersions =
    artifact === "history"
      ? analyticalVersions("listening-volume")
      : artifact === "artists"
        ? analyticalVersions("artist-eras")
        : artifact === "stories"
          ? analyticalVersions("abandonment", "rediscovery")
          : artifact === "genre-lab"
            ? analyticalVersions("genre-eras")
            : [];
  const canonicalEventCount = artifact === "history" ? 3 : 30;
  return {
    analyticalVersions: requiredVersions,
    artifact,
    asOfDate: "2021-01-01",
    coverage: {
      canonicalEventCount,
      dateRange: { endPeriodExclusive: "2021-01", startPeriod: "2020-01" },
      includedSources: ["lastfm", "spotify"],
      spotifyDurationEventCount: artifact === "history" ? 2 : 20,
      unresolvedRate: 0.1,
    },
    data,
    generationVersion: PUBLIC_GENERATION_VERSION,
    publicationDate: null,
    schemaVersion: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    selectionPolicyVersion: PUBLIC_SELECTION_POLICY_VERSION,
    snapshotId: "snapshot-2026-08-09-01",
    timezone: "America/Chicago",
  };
}

function artistComponents() {
  return {
    consecutiveActiveWindows: 2,
    earlierBaselineChange: 12,
    earlierBaselineRollingPlayCount: 12,
    listeningShare: 0.2,
    rank: 1,
    rollingPlayCount: 24,
    strength: 0.8,
    windowPlayCount: 12,
  };
}

function commonContent(slug: string) {
  return {
    accessibilitySummary: "Synthetic accessible summary.",
    body: [{ heading: null, paragraphs: ["Synthetic public prose."] }],
    contentSchemaVersion: "public-content-v1",
    order: 1,
    publicReferences: [],
    publicationStatus: "published",
    slug,
    summary: "Synthetic summary.",
    title: "Synthetic title",
  };
}

function validArtifacts(): readonly unknown[] {
  return [
    commonArtifact("history", {
      canonicalSourceBacking: { both: 1, lastfm: 1, spotify: 1 },
      grain: "month",
      metric: "play_count",
      metricDefinition: "Counts canonical track events once.",
      overlapByYear: [{ eventCount: 1, period: "2020" }],
      parameters: { includeUnresolved: true, rollingWindowPeriods: 1 },
      periods: [
        {
          period: "2020-01",
          playCount: 3,
          priorYearPlayCount: null,
          rollingPlayCount: 3,
          yearOverYearAbsoluteChange: null,
          yearOverYearRate: null,
        },
      ],
      sourceCoverage: [
        {
          byYear: [{ evidenceCount: 12, period: "2020" }],
          longGaps: [{ afterPeriod: "2020-01", beforePeriod: "2020-06", durationDays: 120 }],
          observedEndPeriod: "2020-12",
          observedStartPeriod: "2020-01",
          source: "lastfm",
        },
        {
          byYear: [{ evidenceCount: 12, period: "2020" }],
          longGaps: [],
          observedEndPeriod: "2020-12",
          observedStartPeriod: "2020-01",
          source: "spotify",
        },
      ],
      totalPlayCount: 3,
    }),
    commonArtifact("artists", {
      artists: [
        {
          displayName: "Synthetic Eligible Artist",
          intervals: [
            {
              endPeriodExclusive: "2021-01",
              evidence: [
                { components: artistComponents(), period: "2020-01" },
                { components: artistComponents(), period: "2020-04" },
              ],
              peak: { components: artistComponents(), period: "2020-01" },
              playCount: 24,
              share: 0.2,
              startPeriod: "2020-01",
              strength: 0.8,
            },
          ],
          slug: "synthetic-eligible-artist",
        },
      ],
      parameters: {
        maximumRank: 20,
        minimumConsecutiveActiveWindows: 2,
        minimumEarlierBaselineChange: -12,
        minimumListeningShare: 0.02,
        minimumRollingPlayCount: 12,
        minimumWindowPlayCount: 3,
        rollingWindowCount: 4,
        windowSizeMonths: 3,
      },
    }),
    commonArtifact("editorial", {
      annotations: [
        {
          ...commonContent("synthetic-annotation"),
          period: "2020-01",
          route: "/history/",
        },
      ],
      featuredArtists: [
        {
          ...commonContent("synthetic-feature"),
          artistSlug: "synthetic-eligible-artist",
          storySlugs: ["synthetic-return"],
        },
      ],
    }),
    commonArtifact("stories", {
      stories: [
        {
          ...commonContent("synthetic-return"),
          artistSlug: "synthetic-eligible-artist",
          evidence: {
            classification: "sustained_rediscovery",
            gapDays: 365,
            persistence: "persistent",
            persistencePlayCount: 4,
            priorPeriod: "2019-01",
            priorPlayCount: 10,
            relatedEra: { endPeriodExclusive: "2021-01", startPeriod: "2020-01" },
            returnIntensity: 5,
            returnPeriod: "2020-01",
            returnWindowComplete: true,
          },
          kind: "rediscovery",
          parameters: {
            absenceThresholdDays: 180,
            minimumPersistencePlayCount: 2,
            minimumPriorPlayCount: 5,
            minimumReturnPlayCount: 1,
            persistenceWindowDays: 90,
            returnWindowDays: 30,
            scope: "artist",
          },
          selectedTrack: {
            artistDisplayName: "Synthetic Eligible Artist",
            slug: "synthetic-track",
            storySlug: "synthetic-return",
            trackDisplayName: "Synthetic Track",
          },
          supersedesStorySlug: null,
        },
        {
          ...commonContent("synthetic-dormancy"),
          artistSlug: null,
          evidence: {
            activePeriodCount: 2,
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
              endPeriod: "2018-06",
              playCount: 5,
              startPeriod: "2018-01",
            },
            lastListenPeriod: "2018-06",
            observationDays: 915,
            status: "likely_abandoned_as_of",
          },
          kind: "dormancy",
          parameters: {
            activePeriodGapDays: 90,
            dormancyDays: 180,
            formerCadenceWindowDays: 180,
            likelyAbandonedDays: 365,
            minimumFormerCadencePlayCount: 3,
            minimumHistoricalPlayCount: 5,
            observationWindowDays: 365,
          },
          selectedTrack: null,
          supersedesStorySlug: null,
        },
      ],
    }),
    commonArtifact("genre-lab", {
      contributionVersion: "genre-contribution-v2",
      coverageByYear: [{ period: "2020", rate: 0.5, totalEventCount: 30, usableEventCount: 15 }],
      freshnessDate: "2026-08-09",
      genres: [
        {
          intervals: [
            {
              contribution: 24,
              endPeriodExclusive: "2021-01",
              peakPeriod: "2020-04",
              share: 0.2,
              startPeriod: "2020-01",
              strength: 0.8,
            },
          ],
          label: "Synthetic Genre",
          slug: "synthetic-genre",
        },
      ],
      mode: "raw",
      parameters: {
        maximumRank: 20,
        minimumConsecutiveActiveWindows: 2,
        minimumEarlierBaselineChange: -12,
        minimumListeningShare: 0.02,
        minimumRollingContribution: 12,
        minimumWindowContribution: 3,
        rollingWindowCount: 4,
        windowSizeMonths: 3,
      },
      provider: "musicbrainz",
      status: "experimental",
      taxonomyVersion: null,
      usableEventCoverage: { availableEventCount: 15, rate: 0.5, totalEventCount: 30 },
      weightingLevel: "artist",
    }),
  ];
}

function manifest(state: "approved" | "candidate" = "candidate") {
  const artifacts = {
    artists: { file: PUBLIC_ARTIFACT_FILES.artists, sha256 },
    editorial: { file: PUBLIC_ARTIFACT_FILES.editorial, sha256 },
    genreLab: null,
    history: { file: PUBLIC_ARTIFACT_FILES.history, sha256 },
    stories: { file: PUBLIC_ARTIFACT_FILES.stories, sha256 },
  };
  return {
    analyticalVersions: analyticalVersions(
      "abandonment",
      "artist-eras",
      "listening-volume",
      "rediscovery",
    ),
    approval:
      state === "approved"
        ? { decidedOn: "2026-08-09", decision: "approved", reportSha256: sha256 }
        : null,
    artifacts,
    asOfDate: "2026-08-09",
    coverage: {
      canonicalEventCount: 30,
      dateRange: { endPeriodExclusive: "2021-01", startPeriod: "2020-01" },
      includedSources: ["lastfm", "spotify"],
      spotifyDurationEventCount: 20,
      unresolvedRate: 0.1,
    },
    downloads: [],
    generationVersion: PUBLIC_GENERATION_VERSION,
    publicationDate: state === "approved" ? "2026-08-09" : null,
    publicationPolicy: {
      artwork: "project_owned_or_licensed_only",
      externalRequests: "same_origin_only",
      fonts: "system_only",
      visitorAnalytics: "none",
    },
    reportSha256: sha256,
    schemaVersion: PUBLIC_MANIFEST_SCHEMA_VERSION,
    selectionPolicyVersion: PUBLIC_SELECTION_POLICY_VERSION,
    snapshotId: "snapshot-2026-08-09-01",
    snapshotSha256: sha256,
    state,
    supersedesSnapshotId: null,
    timezone: "America/Chicago",
  };
}

describe("public artifact contract", () => {
  it("accepts every allowlisted artifact schema", () => {
    for (const artifact of validArtifacts()) {
      assert.equal(validatePublicArtifact(artifact), artifact);
    }
  });

  it("rejects unknown and forbidden fields recursively", () => {
    const history = validArtifacts()[0] as Record<string, unknown>;
    assert.throws(
      () => validatePublicArtifact({ ...history, unexpected: true }),
      /unknown field: unexpected/u,
    );
    assert.throws(
      () => validatePublicArtifact({ ...history, ipAddress: "192.0.2.1" }),
      /forbidden private field: ipAddress/u,
    );
    assert.throws(
      () =>
        validatePublicArtifact({
          ...history,
          data: { ...(history.data as object), events: [] },
        }),
      /forbidden private field: events/u,
    );
  });

  it("rejects exact analytical timestamps and ineligible artist detail", () => {
    const history = validArtifacts()[0] as Record<string, unknown>;
    const data = history.data as { periods: readonly Record<string, unknown>[] };
    assert.throws(
      () =>
        validatePublicArtifact({
          ...history,
          data: {
            ...(history.data as object),
            periods: [{ ...data.periods[0], period: "2020-01-01T00:00:00.000Z" }],
          },
        }),
      /YYYY-MM public month granularity/u,
    );

    const artists = validArtifacts()[1] as Record<string, unknown>;
    const artistData = structuredClone(artists.data) as {
      artists: {
        intervals: { evidence: { components: { windowPlayCount: number } }[]; playCount: number }[];
      }[];
    };
    const firstArtist = artistData.artists[0];
    const firstInterval = firstArtist?.intervals[0];
    assert.ok(firstInterval);
    firstInterval.playCount = 23;
    const secondEvidence = firstInterval.evidence[1];
    assert.ok(secondEvidence);
    secondEvidence.components.windowPlayCount = 11;
    assert.throws(
      () => validatePublicArtifact({ ...artists, data: artistData }),
      /does not meet public eligibility/u,
    );
  });

  it("requires applicable analytical versions and closed parameter disclosures", () => {
    const history = structuredClone(validArtifacts()[0]) as Record<string, unknown>;
    history.analyticalVersions = [];
    assert.throws(
      () => validatePublicArtifact(history),
      /missing its required analytical version/u,
    );

    const withoutParameters = structuredClone(validArtifacts()[0]) as Record<string, unknown>;
    delete (withoutParameters.data as Record<string, unknown>).parameters;
    assert.throws(
      () => validatePublicArtifact(withoutParameters),
      /missing required field: parameters/u,
    );
  });

  it("reconciles history totals, backing, overlap, sources, and unique periods", () => {
    const inconsistentTotal = structuredClone(validArtifacts()[0]) as Record<string, unknown>;
    (inconsistentTotal.coverage as { canonicalEventCount: number }).canonicalEventCount = 4;
    assert.throws(
      () => validatePublicArtifact(inconsistentTotal),
      /must equal public canonical coverage/u,
    );

    const duplicatePeriod = structuredClone(validArtifacts()[0]) as Record<string, unknown>;
    const duplicateData = duplicatePeriod.data as {
      periods: Record<string, unknown>[];
      totalPlayCount: number;
    };
    const firstPeriod = duplicateData.periods[0];
    assert.ok(firstPeriod);
    duplicateData.periods.push(structuredClone(firstPeriod));
    duplicateData.totalPlayCount = 6;
    (duplicatePeriod.coverage as { canonicalEventCount: number }).canonicalEventCount = 6;
    assert.throws(() => validatePublicArtifact(duplicatePeriod), /strictly increasing/u);

    const missingSource = structuredClone(validArtifacts()[0]) as Record<string, unknown>;
    (missingSource.data as { sourceCoverage: unknown[] }).sourceCoverage.pop();
    assert.throws(
      () => validatePublicArtifact(missingSource),
      /exactly match the included sources/u,
    );
  });

  it("accepts an explicit empty history without fabricated dates or rows", () => {
    const history = structuredClone(validArtifacts()[0]) as Record<string, unknown>;
    history.asOfDate = null;
    const coverage = history.coverage as Record<string, unknown>;
    coverage.canonicalEventCount = 0;
    coverage.dateRange = null;
    coverage.spotifyDurationEventCount = 0;
    coverage.unresolvedRate = 0;
    const data = history.data as Record<string, unknown>;
    data.canonicalSourceBacking = { both: 0, lastfm: 0, spotify: 0 };
    data.overlapByYear = [];
    data.periods = [];
    data.sourceCoverage = [
      {
        byYear: [],
        longGaps: [],
        observedEndPeriod: null,
        observedStartPeriod: null,
        source: "lastfm",
      },
      {
        byYear: [],
        longGaps: [],
        observedEndPeriod: null,
        observedStartPeriod: null,
        source: "spotify",
      },
    ];
    data.totalPlayCount = 0;
    assert.equal(validatePublicArtifact(history), history);
  });

  it("rejects private locators and unsafe URLs in authored references", () => {
    const editorial = structuredClone(validArtifacts()[2]) as Record<string, unknown>;
    const annotation = (editorial.data as { annotations: Record<string, unknown>[] })
      .annotations[0];
    assert.ok(annotation);
    annotation.route = "file:///data/inputs/private-source.json";
    annotation.publicReferences = ["../../data/inputs/private-source.json"];
    assert.throws(
      () => validatePublicArtifact(editorial),
      /allowlisted route or reviewed HTTPS link|allowlisted same-origin public route/u,
    );

    const safeEditorial = structuredClone(validArtifacts()[2]) as Record<string, unknown>;
    const safeAnnotation = (safeEditorial.data as { annotations: Record<string, unknown>[] })
      .annotations[0];
    assert.ok(safeAnnotation);
    safeAnnotation.publicReferences = [
      "/methodology/#privacy",
      "https://musicbrainz.org/doc/About#license",
    ];
    assert.equal(validatePublicArtifact(safeEditorial), safeEditorial);
  });

  it("rejects reversed intervals, out-of-range peaks, and inconsistent story chronology", () => {
    const artists = structuredClone(validArtifacts()[1]) as Record<string, unknown>;
    const artistInterval = (artists.data as { artists: { intervals: Record<string, unknown>[] }[] })
      .artists[0]?.intervals[0];
    assert.ok(artistInterval);
    artistInterval.endPeriodExclusive = "2020-01";
    assert.throws(() => validatePublicArtifact(artists), /end must be after its start/u);

    const stories = structuredClone(validArtifacts()[3]) as Record<string, unknown>;
    const rediscovery = (stories.data as { stories: { evidence: Record<string, unknown> }[] })
      .stories[0];
    assert.ok(rediscovery);
    rediscovery.evidence.priorPeriod = "2021-01";
    assert.throws(() => validatePublicArtifact(stories), /prior period must not follow/u);

    const inconsistentGap = structuredClone(validArtifacts()[3]) as Record<string, unknown>;
    const gapEvidence = (
      inconsistentGap.data as { stories: { evidence: Record<string, unknown> }[] }
    ).stories[0]?.evidence;
    assert.ok(gapEvidence);
    gapEvidence.gapDays = 30;
    assert.throws(
      () => validatePublicArtifact(inconsistentGap),
      /does not reconcile to its reduced public dates/u,
    );

    const inconsistentObservation = structuredClone(validArtifacts()[3]) as Record<string, unknown>;
    const observationEvidence = (
      inconsistentObservation.data as { stories: { evidence: Record<string, unknown> }[] }
    ).stories[1]?.evidence;
    assert.ok(observationEvidence);
    observationEvidence.observationDays = 365;
    assert.throws(
      () => validatePublicArtifact(inconsistentObservation),
      /does not reconcile to its reduced public dates/u,
    );
  });

  it("accepts only later same-artist rediscovery-to-dormancy supersession", () => {
    const valid = structuredClone(validArtifacts()[3]) as Record<string, unknown>;
    const validStories = (valid.data as { stories: Record<string, unknown>[] }).stories;
    const rediscovery = validStories[0];
    const dormancy = validStories[1];
    assert.ok(rediscovery);
    assert.ok(dormancy);
    dormancy.artistSlug = rediscovery.artistSlug;
    rediscovery.supersedesStorySlug = dormancy.slug;
    assert.equal(validatePublicArtifact(valid), valid);

    const missing = structuredClone(valid) as Record<string, unknown>;
    const missingRediscovery = (missing.data as { stories: Record<string, unknown>[] }).stories[0];
    assert.ok(missingRediscovery);
    missingRediscovery.supersedesStorySlug = "missing-dormancy-story";
    assert.throws(() => validatePublicArtifact(missing), /present dormancy story/u);

    const reversed = structuredClone(valid) as Record<string, unknown>;
    const reversedStories = (reversed.data as { stories: Record<string, unknown>[] }).stories;
    const reversedRediscovery = reversedStories[0];
    const reversedDormancy = reversedStories[1];
    assert.ok(reversedRediscovery);
    assert.ok(reversedDormancy);
    reversedRediscovery.supersedesStorySlug = null;
    reversedDormancy.supersedesStorySlug = reversedRediscovery.slug;
    assert.throws(() => validatePublicArtifact(reversed), /Only a rediscovery story/u);

    const differentArtist = structuredClone(valid) as Record<string, unknown>;
    const differentDormancy = (differentArtist.data as { stories: Record<string, unknown>[] })
      .stories[1];
    assert.ok(differentDormancy);
    differentDormancy.artistSlug = "different-public-artist";
    assert.throws(() => validatePublicArtifact(differentArtist), /same public artist/u);

    const nonLater = structuredClone(valid) as Record<string, unknown>;
    const nonLaterRediscovery = (nonLater.data as { stories: Record<string, unknown>[] })
      .stories[0];
    assert.ok(nonLaterRediscovery);
    const evidence = nonLaterRediscovery.evidence as Record<string, unknown>;
    evidence.priorPeriod = "2017-06";
    evidence.returnPeriod = "2018-06";
    evidence.gapDays = 365;
    assert.throws(() => validatePublicArtifact(nonLater), /must occur after/u);
  });
});

describe("public manifest and review contract", () => {
  it("binds approval to a reviewed report and permits no downloads", () => {
    assert.equal(validatePublicManifest(manifest("candidate")).state, "candidate");
    assert.equal(validatePublicManifest(manifest("approved")).state, "approved");
    assert.throws(
      () => validatePublicManifest({ ...manifest(), downloads: ["history.csv"] }),
      /downloads must be an empty array/u,
    );
    assert.throws(
      () =>
        validatePublicManifest({
          ...manifest("approved"),
          approval: { decidedOn: "2026-08-09", decision: "approved", reportSha256: "b".repeat(64) },
        }),
      /bind the exact reviewed report hash/u,
    );
  });

  it("makes the exact field inventory, artifact hashes, counts, and public slugs reviewable", () => {
    const artifactSummaries = (["history", "artists", "editorial", "stories"] as const).map(
      (artifact) => ({
        artifact,
        fieldAllowlist: PUBLIC_ARTIFACT_FIELD_ALLOWLIST[artifact],
        file: PUBLIC_ARTIFACT_FILES[artifact],
        publicSlugs: artifact === "artists" ? ["synthetic-eligible-artist"] : [],
        recordCount: artifact === "artists" ? 1 : 0,
        sha256,
      }),
    );
    const report = {
      analyticalVersions: analyticalVersions(
        "abandonment",
        "artist-eras",
        "listening-volume",
        "rediscovery",
      ),
      artifactSummaries,
      asOfDate: "2026-08-09",
      candidateManifestSha256: sha256,
      changeSummary: {
        addedPublicSlugs: ["synthetic-eligible-artist"],
        changedArtifacts: ["artists"],
        removedPublicSlugs: [],
        selectionPolicyChanged: false,
      },
      coverage: manifest().coverage,
      generatedOn: "2026-08-09",
      previousSnapshotId: null,
      schemaVersion: PUBLIC_REVIEW_REPORT_SCHEMA_VERSION,
      selectionPolicyVersion: PUBLIC_SELECTION_POLICY_VERSION,
      snapshotId: "snapshot-2026-08-09-01",
    };
    assert.equal(validatePublicReviewReport(report), report);

    const changed = structuredClone(report);
    const firstSummary = changed.artifactSummaries[0];
    assert.ok(firstSummary);
    firstSummary.fieldAllowlist = ["metric", "events"];
    assert.throws(
      () => validatePublicReviewReport(changed),
      /forbidden private field: events|exactly match the executable public allowlist/u,
    );
  });

  it("uses a closed schema that cannot name internal identifiers or an event log", () => {
    const serialized = JSON.stringify({
      fields: PUBLIC_ARTIFACT_FIELD_ALLOWLIST,
      manifest: manifest(),
    });
    for (const forbidden of [
      "artistId",
      "trackId",
      "entityId",
      "sourcePath",
      "fingerprint",
      '"events"',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `unexpected public field ${forbidden}`);
    }
    assert.throws(
      () => validatePublicManifest({ ...manifest(), databaseState: {} }),
      PublicContractError,
    );
  });
});
