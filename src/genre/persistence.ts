import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import {
  type GenreEnrichmentSnapshot,
  MUSICBRAINZ_PROVIDER,
  validateGenreEnrichmentSnapshot,
} from "./evidence-contract.ts";
import type {
  CachedGenreEnrichmentSnapshot,
  GenreEnrichmentSnapshotCache,
  MusicbrainzEnrichmentTarget,
} from "./musicbrainz-client.ts";

interface SnapshotRow extends SqliteRow {
  readonly artist_id: number;
  readonly cache_state: GenreEnrichmentSnapshot["cacheState"];
  readonly contract_version: GenreEnrichmentSnapshot["contractVersion"];
  readonly error_code: GenreEnrichmentSnapshot["errorCode"];
  readonly fetched_at_epoch_ms: number;
  readonly id: number;
  readonly outcome: GenreEnrichmentSnapshot["outcome"];
  readonly provider: GenreEnrichmentSnapshot["provider"];
  readonly provider_attribution: GenreEnrichmentSnapshot["providerAttribution"];
  readonly provider_entity_id: string;
  readonly provider_license: GenreEnrichmentSnapshot["providerLicense"];
  readonly provider_response_schema_version: GenreEnrichmentSnapshot["providerResponseSchemaVersion"];
  readonly supersedes_snapshot_id: number | null;
}

interface RawTagRow extends SqliteRow {
  readonly confidence: number | null;
  readonly is_recognized_genre: number;
  readonly normalized_raw_tag: string;
  readonly raw_tag_name: string;
  readonly raw_weight: number;
}

function toSnapshot(row: SnapshotRow, rawTags: readonly RawTagRow[]): GenreEnrichmentSnapshot {
  const snapshot: GenreEnrichmentSnapshot = {
    artistId: row.artist_id,
    provider: row.provider,
    providerEntityId: row.provider_entity_id,
    providerResponseSchemaVersion: row.provider_response_schema_version,
    contractVersion: row.contract_version,
    providerLicense: row.provider_license,
    providerAttribution: row.provider_attribution,
    fetchedAtEpochMs: row.fetched_at_epoch_ms,
    cacheState: row.cache_state,
    outcome: row.outcome,
    errorCode: row.error_code,
    supersedesSnapshotId: row.supersedes_snapshot_id,
    rawTags: rawTags.map((tag) => ({
      rawTagName: tag.raw_tag_name,
      normalizedRawTag: tag.normalized_raw_tag,
      rawWeight: tag.raw_weight,
      confidence: tag.confidence,
      isRecognizedGenre: tag.is_recognized_genre === 1,
    })),
  };
  validateGenreEnrichmentSnapshot(snapshot);
  return snapshot;
}

function hasSameSnapshotEvidence(
  left: GenreEnrichmentSnapshot,
  right: GenreEnrichmentSnapshot,
): boolean {
  return (
    left.artistId === right.artistId &&
    left.provider === right.provider &&
    left.providerEntityId === right.providerEntityId &&
    left.providerResponseSchemaVersion === right.providerResponseSchemaVersion &&
    left.contractVersion === right.contractVersion &&
    left.providerLicense === right.providerLicense &&
    left.providerAttribution === right.providerAttribution &&
    left.fetchedAtEpochMs === right.fetchedAtEpochMs &&
    left.cacheState === right.cacheState &&
    left.outcome === right.outcome &&
    left.errorCode === right.errorCode &&
    left.supersedesSnapshotId === right.supersedesSnapshotId &&
    left.rawTags.length === right.rawTags.length &&
    [...left.rawTags]
      .sort((first, second) => first.normalizedRawTag.localeCompare(second.normalizedRawTag))
      .every((tag, index) => {
        const other = [...right.rawTags].sort((first, second) =>
          first.normalizedRawTag.localeCompare(second.normalizedRawTag),
        )[index];
        return (
          other !== undefined &&
          tag.rawTagName === other.rawTagName &&
          tag.normalizedRawTag === other.normalizedRawTag &&
          tag.rawWeight === other.rawWeight &&
          tag.confidence === other.confidence &&
          tag.isRecognizedGenre === other.isRecognizedGenre
        );
      })
  );
}

/** SQLite implementation of the optional MusicBrainz snapshot cache. */
export class SqliteGenreEnrichmentSnapshotCache implements GenreEnrichmentSnapshotCache {
  private readonly connection: SqliteConnection;

  constructor(connection: SqliteConnection) {
    this.connection = connection;
  }

  async latest(
    target: MusicbrainzEnrichmentTarget,
  ): Promise<CachedGenreEnrichmentSnapshot | undefined> {
    const row = this.connection
      .prepare<SnapshotRow>(
        `SELECT id, artist_id, provider, provider_entity_id, provider_response_schema_version,
                contract_version, provider_license, provider_attribution, fetched_at_epoch_ms,
                cache_state, outcome, error_code, supersedes_snapshot_id
           FROM genre_enrichment_snapshot
          WHERE artist_id = ? AND provider = ? AND provider_entity_id = ?
          ORDER BY CASE cache_state WHEN 'failure' THEN 1 ELSE 0 END,
                   fetched_at_epoch_ms DESC, id DESC
          LIMIT 1`,
      )
      .get([target.artistId, MUSICBRAINZ_PROVIDER, target.musicbrainzArtistId ?? ""]);
    return row === undefined ? undefined : this.readSnapshot(row);
  }

  async record(snapshot: GenreEnrichmentSnapshot): Promise<CachedGenreEnrichmentSnapshot> {
    validateGenreEnrichmentSnapshot(snapshot);
    return this.connection.transaction(() => {
      const existing = this.connection
        .prepare<SnapshotRow>(
          `SELECT id, artist_id, provider, provider_entity_id, provider_response_schema_version,
                  contract_version, provider_license, provider_attribution, fetched_at_epoch_ms,
                  cache_state, outcome, error_code, supersedes_snapshot_id
             FROM genre_enrichment_snapshot
            WHERE artist_id = ? AND provider = ? AND fetched_at_epoch_ms = ?`,
        )
        .get([snapshot.artistId, snapshot.provider, snapshot.fetchedAtEpochMs]);
      if (existing !== undefined) {
        const stored = this.readSnapshot(existing);
        if (!hasSameSnapshotEvidence(stored.snapshot, snapshot)) {
          throw new Error("Genre enrichment snapshot conflicts with existing immutable evidence");
        }
        return this.readSnapshot(existing);
      }

      const inserted = this.connection
        .prepare(
          `INSERT INTO genre_enrichment_snapshot (
            artist_id, provider, provider_entity_id, provider_response_schema_version,
            contract_version, provider_license, provider_attribution, fetched_at_epoch_ms,
            cache_state, outcome, error_code, supersedes_snapshot_id
          ) VALUES (
            @artistId, @provider, @providerEntityId, @providerResponseSchemaVersion,
            @contractVersion, @providerLicense, @providerAttribution, @fetchedAtEpochMs,
            @cacheState, @outcome, @errorCode, @supersedesSnapshotId
          )`,
        )
        .run({
          artistId: snapshot.artistId,
          provider: snapshot.provider,
          providerEntityId: snapshot.providerEntityId,
          providerResponseSchemaVersion: snapshot.providerResponseSchemaVersion,
          contractVersion: snapshot.contractVersion,
          providerLicense: snapshot.providerLicense,
          providerAttribution: snapshot.providerAttribution,
          fetchedAtEpochMs: snapshot.fetchedAtEpochMs,
          cacheState: snapshot.cacheState,
          outcome: snapshot.outcome,
          errorCode: snapshot.errorCode,
          supersedesSnapshotId: snapshot.supersedesSnapshotId,
        });
      const snapshotId = Number(inserted.lastInsertRowid);
      const insertTag = this.connection.prepare(
        `INSERT INTO genre_enrichment_raw_tag (
          snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const tag of [...snapshot.rawTags].sort((left, right) =>
        left.normalizedRawTag.localeCompare(right.normalizedRawTag),
      )) {
        insertTag.run([
          snapshotId,
          tag.rawTagName,
          tag.normalizedRawTag,
          tag.rawWeight,
          tag.confidence,
          tag.isRecognizedGenre ? 1 : 0,
        ]);
      }
      return { snapshot, snapshotId };
    });
  }

  private readSnapshot(row: SnapshotRow): CachedGenreEnrichmentSnapshot {
    const rawTags = this.connection
      .prepare<RawTagRow>(
        `SELECT raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre
           FROM genre_enrichment_raw_tag
          WHERE snapshot_id = ?
          ORDER BY normalized_raw_tag`,
      )
      .all([row.id]);
    return { snapshot: toSnapshot(row, rawTags), snapshotId: row.id };
  }
}
