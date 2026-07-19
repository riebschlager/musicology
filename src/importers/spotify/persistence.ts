import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { SqliteConnection, SqliteRow } from "../../db/connection.ts";
import {
  HistoricalIngestCommand,
  IngestIssueCode,
  IngestIssueSummary,
  type IngestSummary,
} from "../contracts.ts";
import { fingerprintSourceRecord, hashSourceFile } from "../hashing.ts";
import { IngestLifecycleError, runIngestLifecycle } from "../lifecycle.ts";
import {
  parseSpotifyAudioExport,
  SpotifyExcludedContent,
  SpotifyFileBoundaryError,
  type SpotifyClassifiedRecord,
  type SpotifyRecordRejectionReason,
  type SpotifyTrackSourceRecord,
} from "./boundary.ts";
import { SpotifyAudioExportDiscovery } from "./discovery.ts";

export const SPOTIFY_SOURCE_FINGERPRINT_VERSION = "spotify-source-v1";

interface ExistingFingerprintRow extends SqliteRow {
  readonly found: number;
}

export interface SpotifyNonMusicCounts {
  readonly episodeOrAudiobook: number;
  readonly videoOrUnsupported: number;
}

export interface SpotifyImportSummary extends IngestSummary {
  readonly fingerprintVersion: typeof SPOTIFY_SOURCE_FINGERPRINT_VERSION;
  readonly nonMusic: SpotifyNonMusicCounts;
}

export interface ImportSpotifyFilesOptions {
  readonly candidatePaths: readonly string[];
  readonly connection: SqliteConnection;
  readonly evidenceRoot: string;
  readonly now?: () => number;
  readonly schemaVersion: string;
}

function fingerprintFields(
  record: SpotifyTrackSourceRecord,
): Readonly<Record<string, boolean | null | number | string>> {
  return {
    albumName: record.albumName,
    artistName: record.artistName,
    msPlayed: record.msPlayed,
    offline: record.offline,
    offlineTimestamp: record.offlineTimestamp,
    reasonEnd: record.reasonEnd,
    reasonStart: record.reasonStart,
    shuffle: record.shuffle,
    skipped: record.skipped,
    spotifyTrackUri: record.spotifyTrackUri,
    startedAtEpochMs: record.startedAtEpochMs,
    stoppedAtEpochMs: record.stoppedAtEpochMs,
    trackName: record.trackName,
  };
}

/** Fingerprints the complete privacy-reviewed Spotify track projection, never a raw source row. */
export function fingerprintSpotifyTrackRecord(record: SpotifyTrackSourceRecord): string {
  return fingerprintSourceRecord({
    fields: fingerprintFields(record),
    sourceKind: "spotify",
    version: SPOTIFY_SOURCE_FINGERPRINT_VERSION,
  });
}

function sqliteBoolean(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

function insertAcceptedTrack(
  connection: SqliteConnection,
  runId: number,
  sourceFileId: number,
  ordinal: number,
  record: SpotifyTrackSourceRecord,
  fingerprint: string,
): void {
  const sourceRecord = connection
    .prepare(
      `INSERT INTO source_record
        (source_kind, ingest_run_id, source_file_id, source_ordinal, accepted_at_epoch_ms)
       SELECT 'spotify', @runId, @sourceFileId, @ordinal, started_at_epoch_ms
       FROM ingest_run
       WHERE id = @runId`,
    )
    .run({ ordinal, runId, sourceFileId });

  connection
    .prepare(
      `INSERT INTO spotify_play_source
        (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri,
         artist_name, album_name, track_name, reason_start, reason_end, shuffle,
         skipped, offline, offline_at_epoch_ms, source_fingerprint_sha256)
       VALUES
        (@sourceRecordId, @stoppedAtEpochMs, @msPlayed, @spotifyTrackUri,
         @artistName, @albumName, @trackName, @reasonStart, @reasonEnd, @shuffle,
         @skipped, @offline, @offlineTimestamp, @fingerprint)`,
    )
    .run({
      albumName: record.albumName,
      artistName: record.artistName,
      fingerprint,
      msPlayed: record.msPlayed,
      offline: sqliteBoolean(record.offline),
      offlineTimestamp: record.offlineTimestamp,
      reasonEnd: record.reasonEnd,
      reasonStart: record.reasonStart,
      shuffle: sqliteBoolean(record.shuffle),
      skipped: sqliteBoolean(record.skipped),
      sourceRecordId: Number(sourceRecord.lastInsertRowid),
      spotifyTrackUri: record.spotifyTrackUri,
      stoppedAtEpochMs: record.stoppedAtEpochMs,
      trackName: record.trackName,
    });
}

function insertSafeRejection(
  connection: SqliteConnection,
  runId: number,
  sourceFileId: number,
  ordinal: number,
  reason: SpotifyRecordRejectionReason,
): void {
  connection
    .prepare(
      `INSERT INTO rejected_source_record
        (ingest_run_id, source_file_id, source_ordinal, source_kind, error_code,
         safe_diagnostic_summary, rejected_at_epoch_ms)
       SELECT @runId, @sourceFileId, @ordinal, 'spotify', @errorCode,
              @safeSummary, started_at_epoch_ms
       FROM ingest_run
       WHERE id = @runId`,
    )
    .run({
      errorCode: reason,
      ordinal,
      runId,
      safeSummary: IngestIssueSummary[IngestIssueCode.RejectedRecord],
      sourceFileId,
    });
}

function updateObservedRange(connection: SqliteConnection, sourceFileId: number): void {
  connection
    .prepare(
      `UPDATE source_file
       SET observed_start_epoch_ms = (
             SELECT min(spotify.stopped_at_epoch_ms)
             FROM source_record AS source
             JOIN spotify_play_source AS spotify ON spotify.source_record_id = source.id
             WHERE source.source_file_id = @sourceFileId
           ),
           observed_end_epoch_ms = (
             SELECT max(spotify.stopped_at_epoch_ms)
             FROM source_record AS source
             JOIN spotify_play_source AS spotify ON spotify.source_record_id = source.id
             WHERE source.source_file_id = @sourceFileId
           )
       WHERE id = @sourceFileId`,
    )
    .run({ sourceFileId });
}

function uniqueCandidatePaths(candidatePaths: readonly string[], evidenceRoot: string): string[] {
  return [
    ...new Set(candidatePaths.map((candidatePath) => path.resolve(evidenceRoot, candidatePath))),
  ];
}

/** Imports explicitly named Spotify audio exports as immutable source evidence in one transaction. */
export function importSpotifyFiles(options: ImportSpotifyFilesOptions): SpotifyImportSummary {
  const candidatePaths = uniqueCandidatePaths(options.candidatePaths, options.evidenceRoot);
  const discovered = new SpotifyAudioExportDiscovery(options.evidenceRoot).discover(candidatePaths);
  const nonMusic = { episodeOrAudiobook: 0, videoOrUnsupported: 0 };

  const summary = runIngestLifecycle(
    {
      commandType: HistoricalIngestCommand.Spotify,
      connection: options.connection,
      schemaVersion: options.schemaVersion,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
    (context) => {
      for (let index = discovered.length; index < candidatePaths.length; index += 1) {
        context.recordUnsupportedFile();
      }

      for (const file of discovered) {
        const hashedFile = hashSourceFile(file);
        const registration = context.registerSourceFile(hashedFile);
        if (registration.status === "already_registered") {
          continue;
        }

        let records: readonly SpotifyClassifiedRecord[];
        try {
          const contents = readFileSync(file.absolutePath);
          const contentSha256 = createHash("sha256").update(contents).digest("hex");
          if (
            contents.byteLength !== hashedFile.byteSize ||
            contentSha256 !== hashedFile.contentSha256
          ) {
            throw new IngestLifecycleError(IngestIssueCode.SourceFileChanged);
          }
          records = parseSpotifyAudioExport(contents.toString("utf8"));
        } catch (error) {
          if (error instanceof SpotifyFileBoundaryError) {
            throw new IngestLifecycleError(error.code);
          }
          throw error;
        }

        for (const classified of records) {
          if (classified.kind === "track") {
            const fingerprint = fingerprintSpotifyTrackRecord(classified.record);
            const isDuplicate =
              context.connection
                .prepare<ExistingFingerprintRow>(
                  `SELECT 1 AS found
                   FROM spotify_play_source
                   WHERE source_fingerprint_sha256 = ?
                   LIMIT 1`,
                )
                .get([fingerprint]) !== undefined;
            insertAcceptedTrack(
              context.connection,
              context.runId,
              registration.sourceFileId,
              classified.ordinal,
              classified.record,
              fingerprint,
            );
            context.recordOutcome(
              isDuplicate
                ? {
                    kind: "duplicate",
                    code: IngestIssueCode.DuplicateRecord,
                    sourceFingerprintSha256: fingerprint,
                  }
                : { kind: "accepted", sourceFingerprintSha256: fingerprint },
            );
          } else if (classified.kind === "excluded") {
            if (classified.category === SpotifyExcludedContent.EpisodeOrAudiobook) {
              nonMusic.episodeOrAudiobook += 1;
            } else {
              nonMusic.videoOrUnsupported += 1;
            }
            context.recordOutcome({ kind: "excluded", code: classified.code });
          } else {
            insertSafeRejection(
              context.connection,
              context.runId,
              registration.sourceFileId,
              classified.ordinal,
              classified.reason,
            );
            context.recordOutcome({ kind: "rejected", code: classified.code });
          }
        }

        updateObservedRange(context.connection, registration.sourceFileId);
      }
    },
  );

  return {
    ...summary,
    fingerprintVersion: SPOTIFY_SOURCE_FINGERPRINT_VERSION,
    nonMusic,
  };
}
