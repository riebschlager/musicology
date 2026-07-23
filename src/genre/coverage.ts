import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import type { MusicbrainzEnrichmentTarget } from "./musicbrainz-client.ts";

export const GENRE_ENRICHMENT_COVERAGE_VERSION = "genre-enrichment-coverage-v1";
export const DEFAULT_GENRE_ENRICHMENT_REFRESH_AGE_MS = 180 * 24 * 60 * 60 * 1_000;

export type GenreEnrichmentCoverageState =
  | "enriched"
  | "missing"
  | "ambiguous"
  | "stale"
  | "failed";

export interface GenreEnrichmentCoverageCount {
  readonly artistCount: number;
  readonly eventCount: number;
}

export interface GenreEnrichmentCoverage {
  readonly coverageVersion: typeof GENRE_ENRICHMENT_COVERAGE_VERSION;
  readonly generatedAtEpochMs: number;
  readonly refreshAgeMs: number;
  readonly total: GenreEnrichmentCoverageCount;
  readonly states: Readonly<Record<GenreEnrichmentCoverageState, GenreEnrichmentCoverageCount>>;
}

interface TargetRow extends SqliteRow {
  readonly artist_id: number;
  readonly event_count: number;
  readonly musicbrainz_artist_id: string | null;
  readonly musicbrainz_artist_id_count: number;
}

interface CoverageRow extends SqliteRow {
  readonly artist_count: number;
  readonly event_count: number;
  readonly state: GenreEnrichmentCoverageState;
}

const targetSql = `
  SELECT events.artist_id, events.event_count,
         identifiers.musicbrainz_artist_id, COALESCE(identifiers.musicbrainz_artist_id_count, 0)
           AS musicbrainz_artist_id_count
    FROM (
      SELECT track.artist_id, COUNT(*) AS event_count
        FROM listening_event AS event
        JOIN track ON track.id = event.track_id
       WHERE event.event_status IN ('current', 'unresolved')
       GROUP BY track.artist_id
    ) AS events
    LEFT JOIN (
      SELECT entity_id AS artist_id, COUNT(*) AS musicbrainz_artist_id_count,
             MIN(identifier_value) AS musicbrainz_artist_id
        FROM music_identifier
       WHERE namespace = 'musicbrainz_artist_id' AND is_strong = 1
       GROUP BY entity_id
    ) AS identifiers ON identifiers.artist_id = events.artist_id
   ORDER BY events.event_count DESC, events.artist_id ASC`;

/** Returns targets in a stable order; missing or conflicting strong IDs remain unresolved. */
export function genreEnrichmentTargets(
  connection: SqliteConnection,
): readonly MusicbrainzEnrichmentTarget[] {
  return connection
    .prepare<TargetRow>(targetSql)
    .all()
    .map((row) => ({
      artistId: row.artist_id,
      ...(row.musicbrainz_artist_id_count === 1 && row.musicbrainz_artist_id !== null
        ? { musicbrainzArtistId: row.musicbrainz_artist_id }
        : {}),
    }));
}

export function generateGenreEnrichmentCoverage(
  connection: SqliteConnection,
  options: { readonly now?: () => number; readonly refreshAgeMs?: number } = {},
): GenreEnrichmentCoverage {
  const generatedAtEpochMs = (options.now ?? (() => Date.now()))();
  const refreshAgeMs = options.refreshAgeMs ?? DEFAULT_GENRE_ENRICHMENT_REFRESH_AGE_MS;
  if (!Number.isSafeInteger(generatedAtEpochMs) || generatedAtEpochMs < 0 || refreshAgeMs <= 0) {
    throw new RangeError("Genre enrichment coverage requires valid time parameters");
  }
  const rows = connection
    .prepare<CoverageRow>(
      `WITH artist_population AS (${targetSql}), latest_usable AS (
         SELECT snapshot.*, ROW_NUMBER() OVER (
           PARTITION BY snapshot.artist_id ORDER BY snapshot.fetched_at_epoch_ms DESC, snapshot.id DESC
         ) AS rank
           FROM genre_enrichment_snapshot AS snapshot
           JOIN artist_population AS population
             ON population.artist_id = snapshot.artist_id
            AND population.musicbrainz_artist_id_count = 1
            AND population.musicbrainz_artist_id = snapshot.provider_entity_id
          WHERE snapshot.provider = 'musicbrainz' AND snapshot.cache_state <> 'failure'
       ), latest_failure AS (
         SELECT snapshot.*, ROW_NUMBER() OVER (
           PARTITION BY snapshot.artist_id ORDER BY snapshot.fetched_at_epoch_ms DESC, snapshot.id DESC
         ) AS rank
           FROM genre_enrichment_snapshot AS snapshot
           JOIN artist_population AS population
             ON population.artist_id = snapshot.artist_id
            AND population.musicbrainz_artist_id_count = 1
            AND population.musicbrainz_artist_id = snapshot.provider_entity_id
          WHERE snapshot.provider = 'musicbrainz' AND snapshot.cache_state = 'failure'
       ), classified AS (
         SELECT population.artist_id, population.event_count,
                CASE
                  WHEN population.musicbrainz_artist_id_count <> 1 THEN 'ambiguous'
                  WHEN usable.id IS NOT NULL AND @now - usable.fetched_at_epoch_ms >= @refreshAgeMs THEN 'stale'
                  WHEN usable.cache_state = 'success' THEN 'enriched'
                  WHEN usable.cache_state = 'negative' THEN 'missing'
                  WHEN failure.id IS NOT NULL THEN 'failed'
                  ELSE 'missing'
                END AS state
           FROM artist_population AS population
           LEFT JOIN latest_usable AS usable ON usable.artist_id = population.artist_id AND usable.rank = 1
           LEFT JOIN latest_failure AS failure ON failure.artist_id = population.artist_id AND failure.rank = 1
       )
       SELECT state, COUNT(*) AS artist_count, COALESCE(SUM(event_count), 0) AS event_count
         FROM classified GROUP BY state`,
    )
    .all({ now: generatedAtEpochMs, refreshAgeMs });
  const states: Record<GenreEnrichmentCoverageState, GenreEnrichmentCoverageCount> = {
    enriched: { artistCount: 0, eventCount: 0 },
    missing: { artistCount: 0, eventCount: 0 },
    ambiguous: { artistCount: 0, eventCount: 0 },
    stale: { artistCount: 0, eventCount: 0 },
    failed: { artistCount: 0, eventCount: 0 },
  };
  for (const row of rows)
    states[row.state] = { artistCount: row.artist_count, eventCount: row.event_count };
  const total = Object.values(states).reduce(
    (counts, state) => ({
      artistCount: counts.artistCount + state.artistCount,
      eventCount: counts.eventCount + state.eventCount,
    }),
    { artistCount: 0, eventCount: 0 },
  );
  return {
    coverageVersion: GENRE_ENRICHMENT_COVERAGE_VERSION,
    generatedAtEpochMs,
    refreshAgeMs,
    total,
    states,
  };
}
