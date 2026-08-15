import path from "node:path";

import {
  validatePublicArtifact,
  type PublicArtifactEnvelope,
  type PublicManifest,
} from "../../../src/publication/contract.ts";
import {
  readActivePublicSnapshot,
  readStoredPublicSnapshot,
  type StoredPublicSnapshot,
} from "../../../src/publication/workflow.ts";

export interface PublicHistoryData {
  readonly canonicalSourceBacking: {
    readonly both: number;
    readonly lastfm: number;
    readonly spotify: number;
  };
  readonly grain: "month";
  readonly metric: "play_count";
  readonly metricDefinition: string;
  readonly overlapByYear: readonly { readonly eventCount: number; readonly period: string }[];
  readonly parameters: {
    readonly includeUnresolved: boolean;
    readonly rollingWindowPeriods: number;
  };
  readonly periods: readonly {
    readonly period: string;
    readonly playCount: number;
    readonly priorYearPlayCount: number | null;
    readonly rollingPlayCount: number;
    readonly yearOverYearAbsoluteChange: number | null;
    readonly yearOverYearRate: number | null;
  }[];
  readonly sourceCoverage: readonly {
    readonly byYear: readonly { readonly evidenceCount: number; readonly period: string }[];
    readonly longGaps: readonly {
      readonly afterPeriod: string;
      readonly beforePeriod: string;
      readonly durationDays: number;
    }[];
    readonly observedEndPeriod: string | null;
    readonly observedStartPeriod: string | null;
    readonly source: "lastfm" | "spotify";
  }[];
  readonly totalPlayCount: number;
}

export interface PublicArtistData {
  readonly artists: readonly {
    readonly displayName: string;
    readonly intervals: readonly {
      readonly endPeriodExclusive: string;
      readonly playCount: number;
      readonly share: number;
      readonly startPeriod: string;
      readonly strength: number;
    }[];
    readonly slug: string;
  }[];
  readonly parameters: Readonly<Record<string, number>>;
}

export interface PublicContentBlock {
  readonly heading: string | null;
  readonly paragraphs: readonly string[];
}

export interface PublicEditorialData {
  readonly annotations: readonly {
    readonly accessibilitySummary: string;
    readonly body: readonly PublicContentBlock[];
    readonly order: number;
    readonly period: string | null;
    readonly route: string;
    readonly slug: string;
    readonly summary: string;
    readonly title: string;
  }[];
  readonly featuredArtists: readonly {
    readonly accessibilitySummary: string;
    readonly artistSlug: string;
    readonly body: readonly PublicContentBlock[];
    readonly order: number;
    readonly slug: string;
    readonly storySlugs: readonly string[];
    readonly summary: string;
    readonly title: string;
  }[];
}

export interface PublicStoryData {
  readonly stories: readonly {
    readonly accessibilitySummary: string;
    readonly artistSlug: string | null;
    readonly body: readonly PublicContentBlock[];
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly kind: "dormancy" | "rediscovery";
    readonly order: number;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly selectedTrack: {
      readonly artistDisplayName: string;
      readonly slug: string;
      readonly storySlug: string;
      readonly trackDisplayName: string;
    } | null;
    readonly slug: string;
    readonly summary: string;
    readonly supersedesStorySlug: string | null;
    readonly title: string;
  }[];
}

export interface SiteSnapshot {
  readonly artists: PublicArtifactEnvelope<"artists", PublicArtistData>;
  readonly editorial: PublicArtifactEnvelope<"editorial", PublicEditorialData>;
  readonly history: PublicArtifactEnvelope<"history", PublicHistoryData>;
  readonly manifest: PublicManifest;
  readonly stories: PublicArtifactEnvelope<"stories", PublicStoryData>;
}

export class SiteSnapshotError extends Error {
  readonly code: "invalid_fixture" | "snapshot_invalid" | "snapshot_missing";

  constructor(code: SiteSnapshotError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SiteSnapshotError";
    this.code = code;
  }
}

export interface SiteSnapshotOptions {
  readonly fixture?: unknown;
  readonly projectRoot?: string;
}

const defaultProjectRoot = process.cwd();

export function loadSiteSnapshot(options: SiteSnapshotOptions = {}): SiteSnapshot {
  const projectRoot = options.projectRoot ?? defaultProjectRoot;
  const fixture = options.fixture ?? import.meta.env.MUSICOLOGY_SITE_FIXTURE;

  try {
    if (fixture !== undefined) {
      if (fixture !== "full" && fixture !== "empty") {
        throw new SiteSnapshotError("invalid_fixture", "Site fixture must be either full or empty");
      }
      return toSiteSnapshot(
        readStoredPublicSnapshot(
          path.join(projectRoot, "tests", "fixtures", "public-snapshots", fixture),
        ),
      );
    }

    const publicationDirectory = path.join(projectRoot, "data", "publication");
    const pointer = readActivePublicSnapshot(publicationDirectory);
    const stored = readStoredPublicSnapshot(
      path.join(publicationDirectory, "approved", pointer.snapshotId),
    );
    if (stored.manifest.state !== "approved") {
      throw new SiteSnapshotError("snapshot_invalid", "Active site snapshot is not approved");
    }
    return toSiteSnapshot(stored);
  } catch (error) {
    if (error instanceof SiteSnapshotError) throw error;
    throw new SiteSnapshotError(
      "snapshot_missing",
      "The active public site snapshot is unavailable or invalid",
      { cause: error },
    );
  }
}

function toSiteSnapshot(stored: StoredPublicSnapshot): SiteSnapshot {
  return {
    artists: parseArtifact<"artists", PublicArtistData>(stored, "artists"),
    editorial: parseArtifact<"editorial", PublicEditorialData>(stored, "editorial"),
    history: parseArtifact<"history", PublicHistoryData>(stored, "history"),
    manifest: stored.manifest,
    stories: parseArtifact<"stories", PublicStoryData>(stored, "stories"),
  };
}

function parseArtifact<TName extends "artists" | "editorial" | "history" | "stories", TData>(
  stored: StoredPublicSnapshot,
  name: TName,
): PublicArtifactEnvelope<TName, TData> {
  const artifact = validatePublicArtifact(JSON.parse(stored.artifactBytes[name]));
  if (artifact.artifact !== name) {
    throw new SiteSnapshotError("snapshot_invalid", "Public artifact identity is inconsistent");
  }
  return artifact as PublicArtifactEnvelope<TName, TData>;
}
