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
import { hashSourceFile } from "../hashing.ts";
import { IngestLifecycleError, runIngestLifecycle } from "../lifecycle.ts";
import {
  LASTFM_OVERLAP_FINGERPRINT_VERSION,
  LASTFM_SOURCE_FINGERPRINT_VERSION,
  LastfmFileBoundaryError,
  type LastfmRecordRejectionReason,
  type LastfmScrobbleSourceRecord,
  parseLastfmExport,
} from "./boundary.ts";
import { LastfmExportDiscovery } from "./discovery.ts";
import { lastfmEvidenceLocator } from "./locator.ts";

interface ExistingLastfmEvidenceRow extends SqliteRow {
  readonly source_record_id: number;
}

export interface LastfmExportImportSummary extends IngestSummary {
  readonly fingerprintVersions: {
    readonly overlap: typeof LASTFM_OVERLAP_FINGERPRINT_VERSION;
    readonly source: typeof LASTFM_SOURCE_FINGERPRINT_VERSION;
  };
}

export interface ImportLastfmExportFilesOptions {
  readonly candidatePaths: readonly string[];
  readonly connection: SqliteConnection;
  readonly evidenceRoot: string;
  readonly now?: () => number;
  readonly schemaVersion: string;
}

function sqliteBoolean(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

function insertSourceOccurrence(
  connection: SqliteConnection,
  runId: number,
  sourceFileId: number,
  ordinal: number,
): number {
  const sourceRecord = connection
    .prepare(
      `INSERT INTO source_record
        (source_kind, ingest_run_id, source_file_id, source_ordinal, accepted_at_epoch_ms)
       SELECT 'lastfm', @runId, @sourceFileId, @ordinal, started_at_epoch_ms
       FROM ingest_run
       WHERE id = @runId`,
    )
    .run({ ordinal, runId, sourceFileId });
  return Number(sourceRecord.lastInsertRowid);
}

function insertDistinctEvidence(
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
         release_musicbrainz_id, recording_musicbrainz_id, loved,
         source_fingerprint_sha256)
       VALUES
        (@sourceRecordId, 'export', NULL, @scrobbledAtEpochMs,
         @artistName, @albumName, @trackName, @artistMusicbrainzId,
         @releaseMusicbrainzId, @recordingMusicbrainzId, @loved,
         @sourceFingerprintSha256)`,
    )
    .run({
      albumName: record.albumName,
      artistMusicbrainzId: record.artistMusicbrainzId,
      artistName: record.artistName,
      loved: sqliteBoolean(record.loved),
      recordingMusicbrainzId: record.recordingMusicbrainzId,
      releaseMusicbrainzId: record.releaseMusicbrainzId,
      scrobbledAtEpochMs: record.scrobbledAtEpochMs,
      sourceFingerprintSha256,
      sourceRecordId,
      trackName: record.trackName,
    });
}

function linkOccurrence(
  connection: SqliteConnection,
  sourceRecordId: number,
  lastfmScrobbleSourceRecordId: number,
): void {
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_occurrence
        (source_record_id, lastfm_scrobble_source_record_id, source_origin)
       VALUES (@sourceRecordId, @lastfmScrobbleSourceRecordId, 'export')`,
    )
    .run({ lastfmScrobbleSourceRecordId, sourceRecordId });
}

function insertSafeRejection(
  connection: SqliteConnection,
  runId: number,
  sourceFileId: number,
  ordinal: number,
  reason: LastfmRecordRejectionReason,
): void {
  connection
    .prepare(
      `INSERT INTO rejected_source_record
        (ingest_run_id, source_file_id, source_ordinal, source_kind, error_code,
         safe_diagnostic_summary, rejected_at_epoch_ms)
       SELECT @runId, @sourceFileId, @ordinal, 'lastfm', @errorCode,
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
             SELECT min(lastfm.scrobbled_at_epoch_ms)
             FROM source_record AS source
             JOIN lastfm_scrobble_occurrence AS occurrence
               ON occurrence.source_record_id = source.id
             JOIN lastfm_scrobble_source AS lastfm
               ON lastfm.source_record_id = occurrence.lastfm_scrobble_source_record_id
             WHERE source.source_file_id = @sourceFileId
           ),
           observed_end_epoch_ms = (
             SELECT max(lastfm.scrobbled_at_epoch_ms)
             FROM source_record AS source
             JOIN lastfm_scrobble_occurrence AS occurrence
               ON occurrence.source_record_id = source.id
             JOIN lastfm_scrobble_source AS lastfm
               ON lastfm.source_record_id = occurrence.lastfm_scrobble_source_record_id
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

/** Imports explicitly named Last.fm exports as immutable evidence in one transaction. */
export function importLastfmExportFiles(
  options: ImportLastfmExportFilesOptions,
): LastfmExportImportSummary {
  const candidatePaths = uniqueCandidatePaths(options.candidatePaths, options.evidenceRoot);
  const discovered = new LastfmExportDiscovery(options.evidenceRoot).discover(candidatePaths);

  const summary = runIngestLifecycle(
    {
      commandType: HistoricalIngestCommand.LastfmExport,
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
        const registration = context.registerSourceFile({
          ...hashedFile,
          relativePath: lastfmEvidenceLocator(hashedFile.relativePath),
        });
        if (registration.status === "already_registered") {
          continue;
        }

        let records: ReturnType<typeof parseLastfmExport>;
        try {
          const contents = readFileSync(file.absolutePath);
          const contentSha256 = createHash("sha256").update(contents).digest("hex");
          if (
            contents.byteLength !== hashedFile.byteSize ||
            contentSha256 !== hashedFile.contentSha256
          ) {
            throw new IngestLifecycleError(IngestIssueCode.SourceFileChanged);
          }
          records = parseLastfmExport(contents.toString("utf8"));
        } catch (error) {
          if (error instanceof LastfmFileBoundaryError) {
            throw new IngestLifecycleError(error.code);
          }
          throw error;
        }

        for (const classified of records) {
          if (classified.kind === "scrobble") {
            const existing = context.connection
              .prepare<ExistingLastfmEvidenceRow>(
                `SELECT source_record_id
                 FROM lastfm_scrobble_source
                 WHERE source_fingerprint_sha256 = ?`,
              )
              .get([classified.sourceFingerprintSha256]);
            const sourceRecordId = insertSourceOccurrence(
              context.connection,
              context.runId,
              registration.sourceFileId,
              classified.ordinal,
            );
            const evidenceSourceRecordId = existing?.source_record_id ?? sourceRecordId;
            if (existing === undefined) {
              insertDistinctEvidence(
                context.connection,
                sourceRecordId,
                classified.record,
                classified.sourceFingerprintSha256,
              );
            }
            linkOccurrence(context.connection, sourceRecordId, evidenceSourceRecordId);
            context.recordOutcome(
              existing === undefined
                ? {
                    kind: "accepted",
                    sourceFingerprintSha256: classified.sourceFingerprintSha256,
                  }
                : {
                    kind: "duplicate",
                    code: IngestIssueCode.DuplicateRecord,
                    sourceFingerprintSha256: classified.sourceFingerprintSha256,
                  },
            );
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
    fingerprintVersions: {
      overlap: LASTFM_OVERLAP_FINGERPRINT_VERSION,
      source: LASTFM_SOURCE_FINGERPRINT_VERSION,
    },
  };
}
