import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import { MATCH_TEXT_NORMALIZATION_VERSION, normalizeMatchText } from "./normalization.ts";

export const IDENTITY_RESOLUTION_RULE_VERSION = "identity-resolution-v1";

type ResolutionKind =
  | "manual_decision"
  | "trusted_identifier"
  | "known_alias"
  | "conservative_composite"
  | "new_unresolved";

interface EvidenceRow extends SqliteRow {
  readonly source_record_id: number;
  readonly source_kind: "spotify" | "lastfm";
  readonly artist_name: string;
  readonly album_name: string | null;
  readonly track_name: string;
  readonly spotify_track_uri: string | null;
  readonly artist_musicbrainz_id: string | null;
  readonly release_musicbrainz_id: string | null;
  readonly recording_musicbrainz_id: string | null;
}
interface IdRow extends SqliteRow {
  readonly id: number;
}

export interface IdentityResolutionSummary {
  readonly processed: number;
  readonly resolved: number;
  readonly conflicts: number;
}

function insertEntity(
  connection: SqliteConnection,
  type: "artist" | "release" | "track",
  now: number,
): number {
  return Number(
    connection
      .prepare("INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES (?, ?)")
      .run([type, now]).lastInsertRowid,
  );
}
function findIdentifier(
  connection: SqliteConnection,
  namespace: string,
  value: string | null,
): number | undefined {
  if (value === null) return undefined;
  return connection
    .prepare<IdRow>(
      "SELECT entity_id AS id FROM music_identifier WHERE namespace = ? AND identifier_value = ?",
    )
    .get([namespace, value])?.id;
}
function addIdentifier(
  connection: SqliteConnection,
  entityId: number,
  namespace: string,
  value: string | null,
  sourceRecordId: number,
): void {
  if (value !== null)
    connection
      .prepare(
        "INSERT OR IGNORE INTO music_identifier (entity_id, namespace, identifier_value, is_strong, source_record_id) VALUES (?, ?, ?, 1, ?)",
      )
      .run([entityId, namespace, value, sourceRecordId]);
}
function addAlias(
  connection: SqliteConnection,
  table: "artist_alias" | "release_alias" | "track_alias",
  column: "artist_id" | "release_id" | "track_id",
  entityId: number,
  display: string,
  sourceRecordId: number,
): void {
  const normalized = normalizeMatchText(display);
  if (normalized !== null)
    connection
      .prepare(
        `INSERT OR IGNORE INTO ${table} (${column}, display_alias, normalized_alias, normalization_version, ${table === "artist_alias" ? "alias_source, " : ""}source_record_id) VALUES (?, ?, ?, ?, ${table === "artist_alias" ? "'source', " : ""}?)`,
      )
      .run([entityId, display, normalized, MATCH_TEXT_NORMALIZATION_VERSION, sourceRecordId]);
}
function createArtist(connection: SqliteConnection, name: string, now: number): number {
  const id = insertEntity(connection, "artist", now);
  connection.prepare("INSERT INTO artist (id, preferred_name) VALUES (?, ?)").run([id, name]);
  return id;
}
function createRelease(connection: SqliteConnection, title: string, now: number): number {
  const id = insertEntity(connection, "release", now);
  connection
    .prepare("INSERT INTO release (id, preferred_title, release_type) VALUES (?, ?, 'unknown')")
    .run([id, title]);
  return id;
}
function createTrack(
  connection: SqliteConnection,
  artistId: number,
  title: string,
  releaseId: number | undefined,
  now: number,
): number {
  const id = insertEntity(connection, "track", now);
  connection
    .prepare("INSERT INTO track (id, artist_id, preferred_title, release_id) VALUES (?, ?, ?, ?)")
    .run([id, artistId, title, releaseId ?? null]);
  return id;
}
function uniqueId(
  connection: SqliteConnection,
  sql: string,
  values: readonly (number | string | null)[],
): number | undefined {
  const rows = connection.prepare<IdRow>(sql).all(values);
  return rows.length === 1 ? rows[0]?.id : undefined;
}

/** Resolves all unprocessed evidence atomically; no source rows or identifiers are rewritten. */
export function resolveSourceIdentities(
  connection: SqliteConnection,
  options: { readonly now?: () => number } = {},
): IdentityResolutionSummary {
  const now = (options.now ?? (() => Date.now()))();
  return connection.transaction(() => {
    const evidence = connection
      .prepare<EvidenceRow>(
        `SELECT source.id AS source_record_id, source.source_kind, spotify.artist_name, spotify.album_name, spotify.track_name, spotify.spotify_track_uri, NULL AS artist_musicbrainz_id, NULL AS release_musicbrainz_id, NULL AS recording_musicbrainz_id FROM source_record AS source JOIN spotify_play_source AS spotify ON spotify.source_record_id=source.id LEFT JOIN source_identity_resolution AS resolved ON resolved.source_record_id=source.id WHERE resolved.source_record_id IS NULL UNION ALL SELECT occurrence.source_record_id, 'lastfm', lastfm.artist_name, lastfm.album_name, lastfm.track_name, NULL, lastfm.artist_musicbrainz_id, lastfm.release_musicbrainz_id, lastfm.recording_musicbrainz_id FROM lastfm_scrobble_occurrence AS occurrence JOIN lastfm_scrobble_source AS lastfm ON lastfm.source_record_id=occurrence.lastfm_scrobble_source_record_id LEFT JOIN source_identity_resolution AS resolved ON resolved.source_record_id=occurrence.source_record_id WHERE resolved.source_record_id IS NULL ORDER BY source_record_id`,
      )
      .all();
    let conflicts = 0;
    for (const row of evidence) {
      const artistNorm = normalizeMatchText(row.artist_name);
      const trackNorm = normalizeMatchText(row.track_name);
      const albumNorm = row.album_name === null ? null : normalizeMatchText(row.album_name);
      if (artistNorm === null || trackNorm === null) {
        throw new Error("Accepted source evidence has an empty identity display value");
      }
      const strongArtist = findIdentifier(
        connection,
        "musicbrainz_artist_id",
        row.artist_musicbrainz_id,
      );
      const manualAliasArtist = uniqueId(
        connection,
        "SELECT DISTINCT artist_id AS id FROM artist_alias WHERE normalized_alias = ? AND normalization_version = ? AND alias_source = 'manual'",
        [artistNorm, MATCH_TEXT_NORMALIZATION_VERSION],
      );
      const sourceAliasArtist = uniqueId(
        connection,
        "SELECT DISTINCT artist_id AS id FROM artist_alias WHERE normalized_alias = ? AND normalization_version = ? AND alias_source = 'source'",
        [artistNorm, MATCH_TEXT_NORMALIZATION_VERSION],
      );
      const aliasArtist = manualAliasArtist ?? sourceAliasArtist;
      let artistId = strongArtist ?? aliasArtist;
      let kind: ResolutionKind =
        row.artist_musicbrainz_id !== null
          ? "trusted_identifier"
          : manualAliasArtist !== undefined
            ? "manual_decision"
            : sourceAliasArtist !== undefined
              ? "known_alias"
              : "new_unresolved";
      if (artistId === undefined) artistId = createArtist(connection, row.artist_name, now);
      if (strongArtist !== undefined && aliasArtist !== undefined && strongArtist !== aliasArtist) {
        connection
          .prepare(
            "INSERT OR IGNORE INTO identity_resolution_conflict (source_record_id, entity_type, strong_entity_id, conflicting_entity_id, normalization_version) VALUES (?, 'artist', ?, ?, ?)",
          )
          .run([row.source_record_id, strongArtist, aliasArtist, MATCH_TEXT_NORMALIZATION_VERSION]);
        conflicts++;
      }
      addIdentifier(
        connection,
        artistId,
        "musicbrainz_artist_id",
        row.artist_musicbrainz_id,
        row.source_record_id,
      );
      addAlias(
        connection,
        "artist_alias",
        "artist_id",
        artistId,
        row.artist_name,
        row.source_record_id,
      );
      const strongTrackIds = [
        findIdentifier(connection, "spotify_track_uri", row.spotify_track_uri),
        findIdentifier(connection, "musicbrainz_recording_id", row.recording_musicbrainz_id),
      ].filter((id): id is number => id !== undefined);
      const strongTrack = [...new Set(strongTrackIds)];
      let trackId = strongTrack.length === 1 ? strongTrack[0] : undefined;
      const composite = uniqueId(
        connection,
        `SELECT DISTINCT track.id FROM track JOIN track_alias ON track_alias.track_id=track.id LEFT JOIN release_alias ON release_alias.release_id=track.release_id WHERE track.artist_id=? AND track_alias.normalized_alias=? AND track_alias.normalization_version=? AND ((? IS NULL AND track.release_id IS NULL) OR release_alias.normalized_alias=?)`,
        [artistId, trackNorm, MATCH_TEXT_NORMALIZATION_VERSION, albumNorm, albumNorm],
      );
      if (trackId !== undefined) {
        kind = "trusted_identifier";
        if (composite !== undefined && composite !== trackId) {
          connection
            .prepare(
              "INSERT OR IGNORE INTO identity_resolution_conflict (source_record_id, entity_type, strong_entity_id, conflicting_entity_id, normalization_version) VALUES (?, 'track', ?, ?, ?)",
            )
            .run([row.source_record_id, trackId, composite, MATCH_TEXT_NORMALIZATION_VERSION]);
          conflicts++;
        }
        const trackArtistId = connection
          .prepare<IdRow>("SELECT artist_id AS id FROM track WHERE id=?")
          .get([trackId])?.id;
        if (trackArtistId === undefined) throw new Error("Resolved track is missing its artist");
        if (trackArtistId !== artistId) {
          connection
            .prepare(
              "INSERT OR IGNORE INTO identity_resolution_conflict (source_record_id, entity_type, strong_entity_id, conflicting_entity_id, normalization_version) VALUES (?, 'artist', ?, ?, ?)",
            )
            .run([row.source_record_id, trackArtistId, artistId, MATCH_TEXT_NORMALIZATION_VERSION]);
          conflicts++;
          artistId = trackArtistId;
        }
      }
      let releaseId: number | undefined;
      if (trackId === undefined && composite !== undefined) {
        trackId = composite;
        kind = "conservative_composite";
      }
      if (trackId === undefined) {
        releaseId = findIdentifier(
          connection,
          "musicbrainz_release_id",
          row.release_musicbrainz_id,
        );
        if (releaseId === undefined && row.album_name !== null)
          releaseId = createRelease(connection, row.album_name, now);
        trackId = createTrack(connection, artistId, row.track_name, releaseId, now);
        if (row.spotify_track_uri !== null || row.recording_musicbrainz_id !== null)
          kind = "trusted_identifier";
      }
      const trackRelease = connection
        .prepare<IdRow>("SELECT release_id AS id FROM track WHERE id=?")
        .get([trackId])?.id;
      releaseId = trackRelease ?? releaseId;
      addIdentifier(
        connection,
        trackId,
        "spotify_track_uri",
        row.spotify_track_uri,
        row.source_record_id,
      );
      addIdentifier(
        connection,
        trackId,
        "musicbrainz_recording_id",
        row.recording_musicbrainz_id,
        row.source_record_id,
      );
      if (releaseId !== undefined)
        addIdentifier(
          connection,
          releaseId,
          "musicbrainz_release_id",
          row.release_musicbrainz_id,
          row.source_record_id,
        );
      addAlias(
        connection,
        "track_alias",
        "track_id",
        trackId,
        row.track_name,
        row.source_record_id,
      );
      if (releaseId !== undefined && row.album_name !== null)
        addAlias(
          connection,
          "release_alias",
          "release_id",
          releaseId,
          row.album_name,
          row.source_record_id,
        );
      connection
        .prepare(
          "INSERT INTO source_identity_resolution (source_record_id, artist_id, release_id, track_id, resolution_kind, resolution_rule_version, normalization_version, resolved_at_epoch_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run([
          row.source_record_id,
          artistId,
          releaseId ?? null,
          trackId,
          kind,
          IDENTITY_RESOLUTION_RULE_VERSION,
          MATCH_TEXT_NORMALIZATION_VERSION,
          now,
        ]);
    }
    return { processed: evidence.length, resolved: evidence.length, conflicts };
  });
}
