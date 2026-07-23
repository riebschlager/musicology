import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import { queryCanonicalAnalyticalBase } from "../analytics/base.ts";
import {
  DEFAULT_GENRE_ENRICHMENT_REFRESH_AGE_MS,
  type GenreEnrichmentCoverageCount,
} from "./coverage.ts";

export const GENRE_CONTRIBUTION_VERSION = "genre-contribution-v1";
export const GENRE_CONTRIBUTION_WEIGHTING_LEVEL = "artist";
const CONTRIBUTION_DECIMAL_PLACES = 12;
const CONTRIBUTION_SCALE = 10 ** CONTRIBUTION_DECIMAL_PLACES;

export type GenreContributionMode = "raw" | "curated";

export interface GenreContribution {
  readonly contribution: number;
  readonly genreId: string;
  readonly genreLabel: string;
}

export interface EventGenreContribution {
  readonly artistId: number;
  readonly contributions: readonly GenreContribution[];
  readonly listeningEventId: number;
}

export interface GenreContributionAggregate extends GenreContribution {
  readonly eventCount: number;
}

export interface GenreContributionCoverage {
  readonly missing: GenreEnrichmentCoverageCount;
  readonly total: GenreEnrichmentCoverageCount;
  readonly usable: GenreEnrichmentCoverageCount;
}

export interface GenreContributionFreshness {
  readonly evaluatedAtEpochMs: number;
  readonly fresh: GenreEnrichmentCoverageCount;
  readonly refreshAgeMs: number;
  readonly stale: GenreEnrichmentCoverageCount;
}

export interface GenreContributionResult {
  readonly aggregates: readonly GenreContributionAggregate[];
  readonly coverage: GenreContributionCoverage;
  readonly eventContributions: readonly EventGenreContribution[];
  readonly freshness: GenreContributionFreshness;
  readonly mode: GenreContributionMode;
  readonly provider: "musicbrainz";
  readonly taxonomyVersion: string | null;
  readonly version: typeof GENRE_CONTRIBUTION_VERSION;
  readonly weightingLevel: typeof GENRE_CONTRIBUTION_WEIGHTING_LEVEL;
}

export interface GenerateGenreContributionOptions {
  readonly connection: SqliteConnection;
  readonly mode: GenreContributionMode;
  readonly now?: () => number;
  readonly presentationTimezone: string;
  readonly refreshAgeMs?: number;
  readonly taxonomyVersion?: string;
}

interface EvidenceRow extends SqliteRow {
  readonly artist_id: number;
  readonly fetched_at_epoch_ms: number;
  readonly genre_id: string;
  readonly genre_label: string;
  readonly raw_weight: number;
}

interface ArtistSnapshotRow extends SqliteRow {
  readonly artist_id: number;
  readonly cache_state: "success" | "negative";
  readonly fetched_at_epoch_ms: number;
  readonly snapshot_id: number;
}

interface WeightedGenre {
  readonly genreId: string;
  readonly genreLabel: string;
  readonly rawWeight: number;
}

const latestSuccessfulSnapshotsSql = `
  WITH current_musicbrainz_identity AS (
    SELECT entity_id AS artist_id, MIN(identifier_value) AS provider_entity_id
      FROM music_identifier
     WHERE namespace = 'musicbrainz_artist_id' AND is_strong = 1
     GROUP BY entity_id
    HAVING COUNT(*) = 1
  ), ranked AS (
    SELECT snapshot.id AS snapshot_id, snapshot.artist_id, snapshot.fetched_at_epoch_ms,
           snapshot.cache_state,
           ROW_NUMBER() OVER (
             PARTITION BY snapshot.artist_id
             ORDER BY snapshot.fetched_at_epoch_ms DESC, snapshot.id DESC
           ) AS rank
      FROM genre_enrichment_snapshot AS snapshot
      JOIN current_musicbrainz_identity AS identity
        ON identity.artist_id = snapshot.artist_id
       AND identity.provider_entity_id = snapshot.provider_entity_id
     WHERE snapshot.provider = 'musicbrainz' AND snapshot.cache_state <> 'failure'
  )
  SELECT snapshot_id, artist_id, fetched_at_epoch_ms, cache_state FROM ranked WHERE rank = 1`;

function contributionEvidenceSql(mode: GenreContributionMode): string {
  if (mode === "raw") {
    return `WITH latest AS (${latestSuccessfulSnapshotsSql})
      SELECT latest.artist_id, latest.fetched_at_epoch_ms,
             tag.normalized_raw_tag AS genre_id, tag.raw_tag_name AS genre_label, tag.raw_weight
        FROM latest
        JOIN genre_enrichment_raw_tag AS tag ON tag.snapshot_id = latest.snapshot_id
       WHERE latest.cache_state = 'success' AND tag.raw_weight > 0
       ORDER BY latest.artist_id, tag.normalized_raw_tag`;
  }
  return `WITH latest AS (${latestSuccessfulSnapshotsSql})
    SELECT latest.artist_id, latest.fetched_at_epoch_ms,
           mapping.target_category_id AS genre_id, category.label AS genre_label,
           SUM(tag.raw_weight) AS raw_weight
      FROM latest
      JOIN genre_enrichment_raw_tag AS tag ON tag.snapshot_id = latest.snapshot_id
      JOIN genre_taxonomy_mapping AS mapping
        ON mapping.source_tag = tag.normalized_raw_tag AND mapping.taxonomy_version = @taxonomyVersion
      JOIN genre_taxonomy_category AS category
        ON category.taxonomy_version = mapping.taxonomy_version
       AND category.category_id = mapping.target_category_id
     WHERE mapping.mapping_action <> 'ignore' AND tag.raw_weight > 0
       AND latest.cache_state = 'success'
     GROUP BY latest.artist_id, latest.fetched_at_epoch_ms, mapping.target_category_id, category.label
     ORDER BY latest.artist_id, mapping.target_category_id`;
}

function count(): GenreEnrichmentCoverageCount {
  return { artistCount: 0, eventCount: 0 };
}

function addCount(
  target: GenreEnrichmentCoverageCount,
  artistCount: number,
  eventCount: number,
): GenreEnrichmentCoverageCount {
  return {
    artistCount: target.artistCount + artistCount,
    eventCount: target.eventCount + eventCount,
  };
}

/** Uses UTF-16 code-unit order so the residual allocation is host-locale independent. */
function compareUnicodeCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Calculates artist-level evidence contributions for each canonical event. Positive provider
 * weights are normalized per artist/event; rounding reserves the residual for the final stable
 * genre so each usable event contributes exactly one. No track-level provider evidence exists in
 * P5-06, and no missing or unmapped event is assigned a synthetic genre.
 */
export function generateGenreContributions(
  options: GenerateGenreContributionOptions,
): GenreContributionResult {
  const evaluatedAtEpochMs = (options.now ?? (() => Date.now()))();
  const refreshAgeMs = options.refreshAgeMs ?? DEFAULT_GENRE_ENRICHMENT_REFRESH_AGE_MS;
  if (!Number.isSafeInteger(evaluatedAtEpochMs) || evaluatedAtEpochMs < 0 || refreshAgeMs <= 0) {
    throw new RangeError("Genre contributions require valid freshness parameters");
  }

  return options.connection.transaction((connection) => {
    const taxonomyVersion = validateOptions({ ...options, connection });
    const latestSnapshots = new Map<number, ArtistSnapshotRow>(
      connection
        .prepare<ArtistSnapshotRow>(latestSuccessfulSnapshotsSql)
        .all()
        .map((row) => [row.artist_id, row]),
    );
    const evidence = new Map<number, WeightedGenre[]>();
    for (const row of connection
      .prepare<EvidenceRow>(contributionEvidenceSql(options.mode))
      .all(options.mode === "curated" ? { taxonomyVersion } : undefined)) {
      const genres = evidence.get(row.artist_id) ?? [];
      genres.push({
        genreId: row.genre_id,
        genreLabel: row.genre_label,
        rawWeight: row.raw_weight,
      });
      evidence.set(row.artist_id, genres);
    }

    let total = count();
    let usable = count();
    let missing = count();
    let fresh = count();
    let stale = count();
    const seenArtists = new Set<number>();
    const usableArtists = new Set<number>();
    const eventContributions: EventGenreContribution[] = [];
    const aggregate = new Map<
      string,
      { contribution: number; eventIds: Set<number>; label: string }
    >();
    for (const event of queryCanonicalAnalyticalBase(connection, options.presentationTimezone)) {
      const isNewArtist = !seenArtists.has(event.artistId);
      seenArtists.add(event.artistId);
      const genres = normalizeGenres(evidence.get(event.artistId) ?? []);
      if (genres.length === 0) {
        missing = addCount(missing, isNewArtist ? 1 : 0, 1);
        continue;
      }
      const contributions = allocateContributions(genres);
      eventContributions.push({
        artistId: event.artistId,
        contributions,
        listeningEventId: event.listeningEventId,
      });
      const isNewUsableArtist = !usableArtists.has(event.artistId);
      usableArtists.add(event.artistId);
      usable = addCount(usable, isNewUsableArtist ? 1 : 0, 1);
      const snapshot = latestSnapshots.get(event.artistId);
      if (snapshot === undefined) throw new Error("Genre contribution evidence lacks its snapshot");
      if (evaluatedAtEpochMs - snapshot.fetched_at_epoch_ms >= refreshAgeMs) {
        stale = addCount(stale, isNewUsableArtist ? 1 : 0, 1);
      } else {
        fresh = addCount(fresh, isNewUsableArtist ? 1 : 0, 1);
      }
      for (const contribution of contributions) {
        const value = aggregate.get(contribution.genreId) ?? {
          contribution: 0,
          eventIds: new Set<number>(),
          label: contribution.genreLabel,
        };
        value.contribution += contribution.contribution;
        value.eventIds.add(event.listeningEventId);
        aggregate.set(contribution.genreId, value);
      }
    }
    total = { artistCount: seenArtists.size, eventCount: usable.eventCount + missing.eventCount };
    return {
      aggregates: [...aggregate.entries()]
        .map(([genreId, value]) => ({
          contribution: round(value.contribution),
          eventCount: value.eventIds.size,
          genreId,
          genreLabel: value.label,
        }))
        .sort((left, right) => compareUnicodeCodeUnits(left.genreId, right.genreId)),
      coverage: { missing, total, usable },
      eventContributions,
      freshness: { evaluatedAtEpochMs, fresh, refreshAgeMs, stale },
      mode: options.mode,
      provider: "musicbrainz",
      taxonomyVersion,
      version: GENRE_CONTRIBUTION_VERSION,
      weightingLevel: GENRE_CONTRIBUTION_WEIGHTING_LEVEL,
    };
  }, "deferred");
}

function validateOptions(options: GenerateGenreContributionOptions): string | null {
  if (options.mode !== "raw" && options.mode !== "curated") {
    throw new TypeError("Genre contribution mode must be raw or curated");
  }
  if (options.presentationTimezone.trim() === "") {
    throw new TypeError("Genre contributions require a presentation timezone");
  }
  if (options.mode === "curated") {
    if (options.taxonomyVersion === undefined || options.taxonomyVersion.trim() === "") {
      throw new TypeError("Curated genre contributions require a taxonomy version");
    }
    const version = options.connection
      .prepare<SqliteRow>(
        "SELECT taxonomy_version FROM genre_taxonomy_version WHERE taxonomy_version = ?",
      )
      .get([options.taxonomyVersion]);
    if (version === undefined) throw new TypeError("Genre taxonomy version is not installed");
    return options.taxonomyVersion;
  }
  if (options.taxonomyVersion !== undefined) {
    throw new TypeError("Raw genre contributions must not name a taxonomy version");
  }
  return null;
}

function normalizeGenres(genres: readonly WeightedGenre[]): readonly WeightedGenre[] {
  const byGenre = new Map<string, WeightedGenre>();
  for (const genre of genres) {
    if (!Number.isFinite(genre.rawWeight) || genre.rawWeight <= 0) continue;
    const existing = byGenre.get(genre.genreId);
    byGenre.set(genre.genreId, {
      genreId: genre.genreId,
      genreLabel: genre.genreLabel,
      rawWeight: (existing?.rawWeight ?? 0) + genre.rawWeight,
    });
  }
  return [...byGenre.values()].sort((left, right) =>
    compareUnicodeCodeUnits(left.genreId, right.genreId),
  );
}

function allocateContributions(genres: readonly WeightedGenre[]): readonly GenreContribution[] {
  const totalWeight = genres.reduce((sum, genre) => sum + genre.rawWeight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return [];
  let allocated = 0;
  return genres.map((genre, index) => {
    const contribution =
      index === genres.length - 1 ? round(1 - allocated) : round(genre.rawWeight / totalWeight);
    allocated += contribution;
    return { contribution, genreId: genre.genreId, genreLabel: genre.genreLabel };
  });
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * CONTRIBUTION_SCALE) / CONTRIBUTION_SCALE;
}
