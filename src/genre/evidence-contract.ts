export const GENRE_EVIDENCE_CONTRACT_VERSION = "genre-evidence-v1";
export const MUSICBRAINZ_PROVIDER = "musicbrainz";
export const MUSICBRAINZ_RESPONSE_SCHEMA_VERSION = "musicbrainz-artist-v1";
export const MUSICBRAINZ_LICENSE = "CC0 / CC BY-NC-SA";
export const MUSICBRAINZ_ATTRIBUTION = "MusicBrainz";

export const genreEnrichmentOutcomes = [
  "success",
  "no_tags",
  "not_found",
  "malformed_response",
  "temporary_failure",
] as const;
export type GenreEnrichmentOutcome = (typeof genreEnrichmentOutcomes)[number];

export const genreEnrichmentCacheStates = ["success", "negative", "failure"] as const;
export type GenreEnrichmentCacheState = (typeof genreEnrichmentCacheStates)[number];

export const genreEnrichmentErrorCodes = [
  "malformed_response",
  "not_found",
  "rate_limited",
  "network_failure",
  "timeout",
  "retry_exhausted",
] as const;
export type GenreEnrichmentErrorCode = (typeof genreEnrichmentErrorCodes)[number];

export interface GenreEnrichmentRawTag {
  readonly rawTagName: string;
  readonly normalizedRawTag: string;
  /** Provider-relative vote weight, never an event weight or probability. */
  readonly rawWeight: number;
  /** NULL in SQLite when the provider supplies no confidence. */
  readonly confidence: number | null;
  readonly isRecognizedGenre: boolean;
}

export interface GenreEnrichmentSnapshot {
  readonly artistId: number;
  readonly provider: typeof MUSICBRAINZ_PROVIDER;
  readonly providerEntityId: string;
  readonly providerResponseSchemaVersion: typeof MUSICBRAINZ_RESPONSE_SCHEMA_VERSION;
  readonly contractVersion: typeof GENRE_EVIDENCE_CONTRACT_VERSION;
  readonly providerLicense: typeof MUSICBRAINZ_LICENSE;
  readonly providerAttribution: typeof MUSICBRAINZ_ATTRIBUTION;
  readonly fetchedAtEpochMs: number;
  readonly cacheState: GenreEnrichmentCacheState;
  readonly outcome: GenreEnrichmentOutcome;
  readonly errorCode: GenreEnrichmentErrorCode | null;
  readonly supersedesSnapshotId: number | null;
  readonly rawTags: readonly GenreEnrichmentRawTag[];
}

/** Validates the normalized, privacy-reviewed provider result before persistence. */
export function validateGenreEnrichmentSnapshot(snapshot: GenreEnrichmentSnapshot): void {
  if (!Number.isSafeInteger(snapshot.artistId) || snapshot.artistId <= 0) {
    throw new Error("Genre enrichment snapshot artist ID must be a positive integer");
  }
  if (snapshot.provider !== MUSICBRAINZ_PROVIDER || snapshot.providerEntityId.length === 0) {
    throw new Error("Genre enrichment snapshot must identify its selected provider and entity");
  }
  if (
    snapshot.providerResponseSchemaVersion !== MUSICBRAINZ_RESPONSE_SCHEMA_VERSION ||
    snapshot.contractVersion !== GENRE_EVIDENCE_CONTRACT_VERSION
  ) {
    throw new Error("Genre enrichment snapshot version is unsupported");
  }
  if (!Number.isSafeInteger(snapshot.fetchedAtEpochMs) || snapshot.fetchedAtEpochMs < 0) {
    throw new Error(
      "Genre enrichment snapshot fetch date must be a non-negative epoch millisecond",
    );
  }
  if (
    (snapshot.cacheState === "success" &&
      snapshot.outcome === "success" &&
      snapshot.errorCode === null) ||
    (snapshot.cacheState === "negative" &&
      (snapshot.outcome === "no_tags" || snapshot.outcome === "not_found") &&
      (snapshot.errorCode === null || snapshot.errorCode === "not_found")) ||
    (snapshot.cacheState === "failure" &&
      (snapshot.outcome === "malformed_response" || snapshot.outcome === "temporary_failure") &&
      snapshot.errorCode !== null)
  ) {
    // The database repeats this invariant so callers cannot bypass this boundary.
  } else {
    throw new Error("Genre enrichment cache state, outcome, and error code are inconsistent");
  }
  if (snapshot.cacheState !== "success" && snapshot.rawTags.length > 0) {
    throw new Error("Only successful genre enrichment snapshots may contain raw tags");
  }
  if (snapshot.cacheState === "success" && snapshot.rawTags.length === 0) {
    throw new Error("An empty genre enrichment result must use the negative no_tags outcome");
  }

  const normalizedTags = new Set<string>();
  for (const tag of snapshot.rawTags) {
    if (tag.rawTagName.length === 0 || tag.normalizedRawTag.length === 0) {
      throw new Error("Genre enrichment raw tags must retain raw and normalized text");
    }
    if (!Number.isFinite(tag.rawWeight) || tag.rawWeight < 0) {
      throw new Error("Genre enrichment raw tag weight must be non-negative");
    }
    if (
      tag.confidence !== null &&
      (!Number.isFinite(tag.confidence) || tag.confidence < 0 || tag.confidence > 1)
    ) {
      throw new Error("Genre enrichment raw tag confidence must be between zero and one");
    }
    if (normalizedTags.has(tag.normalizedRawTag)) {
      throw new Error("Genre enrichment snapshot has duplicate normalized raw tags");
    }
    normalizedTags.add(tag.normalizedRawTag);
  }
}
