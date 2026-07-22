import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import { collapseExactDuplicateEvents, createCanonicalEvents } from "../identity/events.ts";
import { resolveSourceIdentities } from "../identity/resolution.ts";
import {
  IngestIssueCode,
  SourceEvidenceIngestCommand,
  type IngestSummary,
  type SuccessfulIngestRunContext,
} from "../importers/contracts.ts";
import { runIngestLifecycle } from "../importers/lifecycle.ts";
import {
  fingerprintLastfmScrobble,
  type LastfmScrobbleSourceRecord,
} from "../importers/lastfm-export/boundary.ts";
import { applyReconciliationDecisions } from "../reconciliation/apply.ts";
import type { ReconciliationApplySummary } from "../reconciliation/apply.ts";
import { generateCrossSourceCandidates } from "../reconciliation/candidates.ts";
import { calculateCrossSourceMatchFeatures } from "../reconciliation/features.ts";
import type { LastfmCompletedTrack, LastfmRecentTracksPage } from "./client.ts";

interface ExistingEvidenceRow extends SqliteRow {
  readonly artist_musicbrainz_id: string | null;
  readonly release_musicbrainz_id: string | null;
  readonly recording_musicbrainz_id: string | null;
  readonly source_record_id: number;
}

export interface PersistLastfmApiPagesOptions {
  readonly connection: SqliteConnection;
  readonly now?: () => number;
  /** Runs after the API ingest run succeeds but before its transaction commits. */
  readonly onSuccessfulRun?: (context: SuccessfulIngestRunContext) => void;
  readonly pages: readonly LastfmRecentTracksPage[];
  readonly schemaVersion: string;
}

export interface LastfmApiPersistenceSummary extends IngestSummary {
  readonly reconciliation: ReconciliationApplySummary;
  readonly response: {
    readonly completedTracks: number;
    readonly ignoredNowPlaying: number;
    readonly pages: number;
  };
  readonly pipeline: {
    readonly canonicalEvents: number;
    readonly candidatePairs: number;
    readonly exactDuplicatesCollapsed: number;
    readonly identitiesResolved: number;
    readonly matchFeatures: number;
  };
}

function sqliteBoolean(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

/** Converts the already validated API projection to the shared privacy-reviewed evidence shape. */
export function lastfmApiTrackToSourceRecord(
  track: LastfmCompletedTrack,
): LastfmScrobbleSourceRecord {
  return {
    albumName: track.albumName,
    artistMusicbrainzId: track.artistMusicbrainzId,
    artistName: track.artistName,
    loved: track.loved,
    recordingMusicbrainzId: track.recordingMusicbrainzId,
    releaseMusicbrainzId: track.releaseMusicbrainzId,
    scrobbledAtEpochMs: track.scrobbledAtEpochMs,
    trackName: track.trackName,
  };
}

function insertApiOccurrence(connection: SqliteConnection, runId: number): number {
  return Number(
    connection
      .prepare(
        `INSERT INTO source_record (source_kind, ingest_run_id, accepted_at_epoch_ms)
         SELECT 'lastfm', @runId, started_at_epoch_ms FROM ingest_run WHERE id = @runId`,
      )
      .run({ runId }).lastInsertRowid,
  );
}

function insertApiEvidence(
  connection: SqliteConnection,
  sourceRecordId: number,
  record: LastfmScrobbleSourceRecord,
  sourceFingerprintSha256: string,
): void {
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_source
        (source_record_id, source_origin, api_scrobble_id, scrobbled_at_epoch_ms,
         artist_name, album_name, track_name, artist_musicbrainz_id,
         release_musicbrainz_id, recording_musicbrainz_id, loved, source_fingerprint_sha256)
       VALUES (@sourceRecordId, 'api', NULL, @scrobbledAtEpochMs, @artistName, @albumName,
               @trackName, @artistMusicbrainzId, @releaseMusicbrainzId,
               @recordingMusicbrainzId, @loved, @sourceFingerprintSha256)`,
    )
    .run({ ...record, loved: sqliteBoolean(record.loved), sourceFingerprintSha256, sourceRecordId });
}

function linkApiOccurrence(
  connection: SqliteConnection,
  sourceRecordId: number,
  evidenceSourceRecordId: number,
): void {
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_occurrence
        (source_record_id, lastfm_scrobble_source_record_id, source_origin)
       VALUES (?, ?, 'api')`,
    )
    .run([sourceRecordId, evidenceSourceRecordId]);
}

function noStrongIdentifierConflict(
  candidate: ExistingEvidenceRow,
  record: LastfmScrobbleSourceRecord,
): boolean {
  return (
    (candidate.artist_musicbrainz_id === null || record.artistMusicbrainzId === null || candidate.artist_musicbrainz_id === record.artistMusicbrainzId) &&
    (candidate.release_musicbrainz_id === null || record.releaseMusicbrainzId === null || candidate.release_musicbrainz_id === record.releaseMusicbrainzId) &&
    (candidate.recording_musicbrainz_id === null || record.recordingMusicbrainzId === null || candidate.recording_musicbrainz_id === record.recordingMusicbrainzId)
  );
}

function matchingEvidence(
  connection: SqliteConnection,
  record: LastfmScrobbleSourceRecord,
  sourceFingerprintSha256: string,
): ExistingEvidenceRow | undefined {
  const exact = connection
    .prepare<ExistingEvidenceRow>(
      `SELECT source_record_id, artist_musicbrainz_id, release_musicbrainz_id,
              recording_musicbrainz_id
         FROM lastfm_scrobble_source WHERE source_fingerprint_sha256 = ?`,
    )
    .get([sourceFingerprintSha256]);
  if (exact !== undefined) return exact;
  const candidates = connection
    .prepare<ExistingEvidenceRow>(
      `SELECT source_record_id, artist_musicbrainz_id, release_musicbrainz_id,
              recording_musicbrainz_id
         FROM lastfm_scrobble_source
        WHERE artist_name = @artistName AND track_name = @trackName
          AND scrobbled_at_epoch_ms = @scrobbledAtEpochMs`,
    )
    .all(record)
    .filter((candidate) => noStrongIdentifierConflict(candidate, record));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function apiOccurrenceAlreadyPersisted(connection: SqliteConnection, fingerprint: string): boolean {
  return (
    connection
      .prepare<SqliteRow>(
        `SELECT 1 AS found
           FROM lastfm_scrobble_occurrence AS occurrence
           JOIN lastfm_scrobble_source AS evidence
             ON evidence.source_record_id = occurrence.lastfm_scrobble_source_record_id
          WHERE occurrence.source_origin = 'api' AND evidence.source_fingerprint_sha256 = ?
          LIMIT 1`,
      )
      .get([fingerprint]) !== undefined
  );
}

/** Persists completed API pages and applies the shared identity and reconciliation pipeline. */
export function persistLastfmApiPages(
  options: PersistLastfmApiPagesOptions,
): LastfmApiPersistenceSummary {
  const response = {
    completedTracks: options.pages.reduce((total, page) => total + page.completedTracks.length, 0),
    ignoredNowPlaying: options.pages.reduce((total, page) => total + page.ignoredNowPlayingCount, 0),
    pages: options.pages.length,
  };
  let pipeline: LastfmApiPersistenceSummary["pipeline"] | undefined;
  let reconciliation: ReconciliationApplySummary | undefined;
  const summary = runIngestLifecycle(
    {
      commandType: SourceEvidenceIngestCommand.LastfmApi,
      connection: options.connection,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.onSuccessfulRun === undefined ? {} : { afterSuccess: options.onSuccessfulRun }),
      schemaVersion: options.schemaVersion,
    },
    (context) => {
      for (const page of options.pages) for (const track of page.completedTracks) {
        const record = lastfmApiTrackToSourceRecord(track);
        const fingerprint = fingerprintLastfmScrobble(record);
        if (apiOccurrenceAlreadyPersisted(context.connection, fingerprint)) continue;
        const existing = matchingEvidence(context.connection, record, fingerprint);
        const sourceRecordId = insertApiOccurrence(context.connection, context.runId);
        const evidenceSourceRecordId = existing?.source_record_id ?? sourceRecordId;
        if (existing === undefined) insertApiEvidence(context.connection, sourceRecordId, record, fingerprint);
        linkApiOccurrence(context.connection, sourceRecordId, evidenceSourceRecordId);
        context.recordOutcome(
          existing === undefined
            ? { kind: "accepted", sourceFingerprintSha256: fingerprint }
            : {
                kind: "duplicate",
                code: IngestIssueCode.DuplicateRecord,
                sourceFingerprintSha256: fingerprint,
              },
        );
      }
      context.connection
        .prepare(
          `INSERT INTO lastfm_api_sync_metadata
            (ingest_run_id, page_count, completed_track_count, ignored_now_playing_count)
           VALUES (?, ?, ?, ?)`,
        )
        .run([context.runId, response.pages, response.completedTracks, response.ignoredNowPlaying]);
      const identityOptions = options.now === undefined ? {} : { now: options.now };
      const identities = resolveSourceIdentities(context.connection, identityOptions);
      const events = createCanonicalEvents(context.connection);
      const duplicates = collapseExactDuplicateEvents(context.connection);
      const candidates = generateCrossSourceCandidates(context.connection, identityOptions);
      const features = calculateCrossSourceMatchFeatures(context.connection);
      reconciliation = applyReconciliationDecisions(context.connection, identityOptions);
      pipeline = {
        canonicalEvents: events.processed,
        candidatePairs: candidates.inserted,
        exactDuplicatesCollapsed: duplicates.spotifyEventsCollapsed + duplicates.lastfmEventsCollapsed,
        identitiesResolved: identities.resolved,
        matchFeatures: features.inserted,
      };
    },
  );
  if (pipeline === undefined || reconciliation === undefined)
    throw new Error("Last.fm API persistence pipeline did not complete");
  return { ...summary, pipeline, reconciliation, response };
}
