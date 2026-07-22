import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import type { IntegrityCheckResult, SqliteConnection, SqliteRow } from "../db/connection.ts";
import { IngestIssueSummary } from "../importers/contracts.ts";
import {
  fingerprintLastfmScrobble,
  LastfmRecordRejectionReason,
} from "../importers/lastfm-export/boundary.ts";
import { resolveLastfmEvidenceLocator } from "../importers/lastfm-export/locator.ts";
import { SpotifyRecordRejectionReason } from "../importers/spotify/boundary.ts";
import { fingerprintSpotifyTrackRecord } from "../importers/spotify/persistence.ts";
import { ARCHIVE_BASELINE } from "../reporting/archive-baseline.ts";

export interface EvidenceValidationIssue {
  readonly code: string;
  readonly message: string;
}

export interface EvidenceValidationResult {
  readonly ok: boolean;
  readonly checked: {
    readonly sourceFiles: number;
    readonly ingestRuns: number;
    readonly sourceRecords: number;
    readonly rejectedRecords: number;
    readonly fingerprints: number;
    readonly canonicalEvents: number;
    readonly reconciliationCandidates: number;
  };
  readonly integrity: IntegrityCheckResult;
  readonly errors: readonly EvidenceValidationIssue[];
  readonly findings: readonly EvidenceValidationIssue[];
}

interface SourceFileRow extends SqliteRow {
  readonly id: number;
  readonly relative_path: string;
  readonly source_type: "lastfm_export" | "spotify_export";
  readonly byte_size: number;
  readonly content_sha256: string;
  readonly first_ingest_run_id: number;
  readonly last_ingest_run_id: number;
}

interface IngestRunRow extends SqliteRow {
  readonly id: number;
  readonly command_type: string;
  readonly status: "failed" | "running" | "succeeded";
  readonly safe_error_summary: string | null;
  readonly discovered_file_count: number;
  readonly registered_file_count: number;
  readonly noop_file_count: number;
  readonly unsupported_count: number;
  readonly discovered_count: number;
  readonly accepted_count: number;
  readonly duplicated_count: number;
  readonly excluded_count: number;
  readonly rejected_count: number;
}

interface CountRow extends SqliteRow {
  readonly count: number;
}

interface OrdinalRow extends SqliteRow {
  readonly source_file_id: number;
  readonly source_ordinal: number | null;
  readonly source_kind: string;
  readonly record_kind: "accepted" | "rejected";
}

interface SpotifyFingerprintRow extends SqliteRow {
  readonly source_record_id: number;
  readonly stopped_at_epoch_ms: number;
  readonly ms_played: number;
  readonly spotify_track_uri: string;
  readonly artist_name: string;
  readonly album_name: string | null;
  readonly track_name: string;
  readonly reason_start: string | null;
  readonly reason_end: string | null;
  readonly shuffle: number;
  readonly skipped: number | null;
  readonly offline: number | null;
  readonly offline_at_epoch_ms: number | null;
  readonly source_fingerprint_sha256: string;
}

interface LastfmFingerprintRow extends SqliteRow {
  readonly source_record_id: number;
  readonly scrobbled_at_epoch_ms: number;
  readonly artist_name: string;
  readonly album_name: string | null;
  readonly track_name: string;
  readonly artist_musicbrainz_id: string | null;
  readonly release_musicbrainz_id: string | null;
  readonly recording_musicbrainz_id: string | null;
  readonly loved: number | null;
  readonly source_fingerprint_sha256: string;
}

interface RejectionRow extends SqliteRow {
  readonly id: number;
  readonly ingest_run_id: number;
  readonly source_file_id: number | null;
  readonly source_ordinal: number | null;
  readonly source_kind: string;
  readonly error_code: string;
  readonly safe_diagnostic_summary: string;
}

function addError(errors: EvidenceValidationIssue[], code: string, message: string): void {
  errors.push({ code, message });
}

function count(
  connection: SqliteConnection,
  sql: string,
  parameters: readonly number[] = [],
): number {
  return connection.prepare<CountRow>(sql).get(parameters)?.count ?? 0;
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function validateSourceFiles(
  connection: SqliteConnection,
  evidenceRoot: string,
  errors: EvidenceValidationIssue[],
): readonly SourceFileRow[] {
  const files = connection
    .prepare<SourceFileRow>(
      `SELECT id, relative_path, source_type, byte_size, content_sha256,
              first_ingest_run_id, last_ingest_run_id
       FROM source_file
       ORDER BY id`,
    )
    .all();
  const resolvedRoot = path.resolve(evidenceRoot);

  for (const file of files) {
    const storedCandidate = path.resolve(resolvedRoot, file.relative_path);
    const candidate =
      file.source_type === "lastfm_export" && !existsSync(storedCandidate)
        ? (resolveLastfmEvidenceLocator(resolvedRoot, file.relative_path) ?? storedCandidate)
        : storedCandidate;
    if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
      addError(
        errors,
        "source_file_path_invalid",
        `Source file ${file.id} has a path outside the configured evidence root.`,
      );
      continue;
    }
    if (!existsSync(candidate)) {
      addError(
        errors,
        "source_file_missing",
        `Registered source file ${file.id} is missing from its evidence path.`,
      );
      continue;
    }

    let sourceBytes: Buffer;
    try {
      if (!lstatSync(candidate).isFile()) {
        addError(
          errors,
          "source_file_not_regular",
          `Registered source file ${file.id} is not a regular file.`,
        );
        continue;
      }
      const realRoot = realpathSync.native(resolvedRoot);
      const realCandidate = realpathSync.native(candidate);
      const realRelative = path.relative(realRoot, realCandidate);
      if (
        realRelative === "" ||
        realRelative === ".." ||
        realRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelative)
      ) {
        addError(
          errors,
          "source_file_path_invalid",
          `Source file ${file.id} resolves outside the configured evidence root.`,
        );
        continue;
      }
      sourceBytes = readFileSync(candidate);
    } catch {
      addError(
        errors,
        "source_file_unreadable",
        `Registered source file ${file.id} could not be read for validation.`,
      );
      continue;
    }

    if (sourceBytes.byteLength !== file.byte_size || sha256(sourceBytes) !== file.content_sha256) {
      addError(
        errors,
        "source_file_changed",
        `Registered source file ${file.id} no longer matches its stored size and content hash; evidence was not modified.`,
      );
    }
  }

  return files;
}

function duplicateCountForRun(connection: SqliteConnection, runId: number): number {
  return count(
    connection,
    `SELECT count(*) AS count
     FROM source_record AS source
     WHERE source.ingest_run_id = ?
       AND (
         EXISTS (
           SELECT 1
           FROM spotify_play_source AS current_spotify
           JOIN spotify_play_source AS earlier_spotify
             ON earlier_spotify.source_fingerprint_sha256 = current_spotify.source_fingerprint_sha256
            AND earlier_spotify.source_record_id < current_spotify.source_record_id
           WHERE current_spotify.source_record_id = source.id
         )
         OR EXISTS (
           SELECT 1
           FROM lastfm_scrobble_occurrence AS occurrence
           WHERE occurrence.source_record_id = source.id
             AND occurrence.source_record_id <> occurrence.lastfm_scrobble_source_record_id
         )
       )`,
    [runId],
  );
}

function validateIngestRuns(
  connection: SqliteConnection,
  errors: EvidenceValidationIssue[],
): readonly IngestRunRow[] {
  const runs = connection.prepare<IngestRunRow>("SELECT * FROM ingest_run ORDER BY id").all();
  const allowedErrorSummaries = new Set<string>(Object.values(IngestIssueSummary));

  for (const run of runs) {
    const accepted = count(
      connection,
      "SELECT count(*) AS count FROM source_record WHERE ingest_run_id = ?",
      [run.id],
    );
    const rejected = count(
      connection,
      "SELECT count(*) AS count FROM rejected_source_record WHERE ingest_run_id = ?",
      [run.id],
    );
    const registered = count(
      connection,
      "SELECT count(*) AS count FROM source_file WHERE first_ingest_run_id = ?",
      [run.id],
    );
    const duplicated = duplicateCountForRun(connection, run.id);

    if (
      (run.status === "failed" &&
        (run.safe_error_summary === null || !allowedErrorSummaries.has(run.safe_error_summary))) ||
      (run.status !== "failed" && run.safe_error_summary !== null)
    ) {
      addError(
        errors,
        "ingest_run_error_summary_unsafe",
        `Ingest run ${run.id} does not use an approved safe error summary for its status.`,
      );
    }

    if (run.status === "running") {
      addError(
        errors,
        "ingest_run_incomplete",
        `Ingest run ${run.id} is still marked running and requires recovery or investigation.`,
      );
    }
    if (run.status !== "succeeded") {
      if (accepted !== 0 || rejected !== 0 || registered !== 0) {
        addError(
          errors,
          "failed_ingest_has_evidence",
          `Non-successful ingest run ${run.id} owns persisted source evidence.`,
        );
      }
      continue;
    }

    if (
      run.discovered_count !== run.accepted_count + run.excluded_count + run.rejected_count ||
      run.discovered_file_count !==
        run.registered_file_count + run.noop_file_count + run.unsupported_count ||
      run.duplicated_count > run.accepted_count
    ) {
      addError(
        errors,
        "ingest_run_totals_unreconciled",
        `Succeeded ingest run ${run.id} has internally inconsistent stored totals.`,
      );
    }
    if (
      accepted !== run.accepted_count ||
      rejected !== run.rejected_count ||
      registered !== run.registered_file_count ||
      duplicated !== run.duplicated_count
    ) {
      addError(
        errors,
        "ingest_run_persistence_mismatch",
        `Succeeded ingest run ${run.id} totals do not match its persisted evidence.`,
      );
    }
  }

  return runs;
}

function validateSourceOwnership(
  connection: SqliteConnection,
  errors: EvidenceValidationIssue[],
): void {
  const invalidFileRunLinks = count(
    connection,
    `SELECT count(*) AS count
     FROM source_file AS file
     LEFT JOIN ingest_run AS first_run ON first_run.id = file.first_ingest_run_id
     LEFT JOIN ingest_run AS last_run ON last_run.id = file.last_ingest_run_id
     WHERE first_run.id IS NULL
        OR last_run.id IS NULL
        OR first_run.status <> 'succeeded'
        OR last_run.status <> 'succeeded'
        OR file.first_ingest_run_id > file.last_ingest_run_id
        OR (file.source_type = 'spotify_export'
            AND (first_run.command_type <> 'spotify_import'
                 OR last_run.command_type <> 'spotify_import'))
        OR (file.source_type = 'lastfm_export'
            AND (first_run.command_type <> 'lastfm_export_import'
                 OR last_run.command_type <> 'lastfm_export_import'))
        OR (file.first_ingest_run_id = file.last_ingest_run_id
            AND first_run.registered_file_count = 0)
        OR (file.first_ingest_run_id <> file.last_ingest_run_id
            AND last_run.noop_file_count = 0)`,
  );
  if (invalidFileRunLinks > 0) {
    addError(
      errors,
      "source_file_run_link_invalid",
      `${invalidFileRunLinks} source file(s) have incompatible first or last ingest-run ownership.`,
    );
  }

  const invalidSourceRecords = count(
    connection,
    `SELECT count(*) AS count
     FROM source_record AS source
     LEFT JOIN ingest_run AS run ON run.id = source.ingest_run_id
     LEFT JOIN source_file AS file ON file.id = source.source_file_id
     WHERE run.id IS NULL
        OR (source.source_kind = 'spotify'
            AND (run.command_type <> 'spotify_import'
                 OR file.source_type IS NULL
                 OR file.source_type <> 'spotify_export'
                 OR source.ingest_run_id <> file.first_ingest_run_id))
        OR (source.source_kind = 'lastfm'
            AND ((run.command_type = 'lastfm_export_import'
                  AND (file.source_type IS NULL
                       OR file.source_type <> 'lastfm_export'
                       OR source.ingest_run_id <> file.first_ingest_run_id))
                 OR (run.command_type = 'lastfm_api_sync' AND source.source_file_id IS NOT NULL)
                 OR run.command_type NOT IN ('lastfm_export_import', 'lastfm_api_sync')))`,
  );
  if (invalidSourceRecords > 0) {
    addError(
      errors,
      "source_record_ownership_invalid",
      `${invalidSourceRecords} accepted source record(s) have incompatible file or ingest-run ownership.`,
    );
  }

  const invalidRejections = count(
    connection,
    `SELECT count(*) AS count
     FROM rejected_source_record AS rejection
     LEFT JOIN ingest_run AS run ON run.id = rejection.ingest_run_id
     LEFT JOIN source_file AS file ON file.id = rejection.source_file_id
     WHERE run.id IS NULL
        OR file.id IS NULL
        OR rejection.ingest_run_id <> file.first_ingest_run_id
        OR (rejection.source_kind = 'spotify'
            AND (run.command_type <> 'spotify_import'
                 OR file.source_type <> 'spotify_export'))
        OR (rejection.source_kind = 'lastfm'
            AND (run.command_type <> 'lastfm_export_import'
                 OR file.source_type <> 'lastfm_export'))`,
  );
  if (invalidRejections > 0) {
    addError(
      errors,
      "rejection_ownership_invalid",
      `${invalidRejections} rejected source record(s) have incompatible file or ingest-run ownership.`,
    );
  }
}

function validateOrdinals(
  connection: SqliteConnection,
  files: readonly SourceFileRow[],
  runs: readonly IngestRunRow[],
  errors: EvidenceValidationIssue[],
): void {
  const rows = connection
    .prepare<OrdinalRow>(
      `SELECT source_file_id, source_ordinal, source_kind, 'accepted' AS record_kind
       FROM source_record
       WHERE source_file_id IS NOT NULL
       UNION ALL
       SELECT source_file_id, source_ordinal, source_kind, 'rejected' AS record_kind
       FROM rejected_source_record
       WHERE source_file_id IS NOT NULL
       ORDER BY source_file_id, source_ordinal`,
    )
    .all();
  const rowsByFile = new Map<number, OrdinalRow[]>();
  for (const row of rows) {
    const fileRows = rowsByFile.get(row.source_file_id) ?? [];
    fileRows.push(row);
    rowsByFile.set(row.source_file_id, fileRows);
  }

  const inferredByRun = new Map<number, { records: number; excluded: number }>();
  for (const file of files) {
    const fileRows = rowsByFile.get(file.id) ?? [];
    const ordinals = new Set<number>();
    for (const row of fileRows) {
      if (row.source_ordinal === null || row.source_ordinal < 0) {
        addError(
          errors,
          "record_ordinal_invalid",
          `Source file ${file.id} has a record without a valid zero-based ordinal.`,
        );
        continue;
      }
      if (ordinals.has(row.source_ordinal)) {
        addError(
          errors,
          "record_ordinal_conflict",
          `Source file ${file.id} has more than one persisted outcome at ordinal ${row.source_ordinal}.`,
        );
      }
      ordinals.add(row.source_ordinal);
      const expectedKind = file.source_type === "spotify_export" ? "spotify" : "lastfm";
      if (row.source_kind !== expectedKind) {
        addError(
          errors,
          "record_source_kind_mismatch",
          `Source file ${file.id} has evidence assigned to the wrong source kind.`,
        );
      }
    }

    const inferredRecords = ordinals.size === 0 ? 0 : Math.max(...ordinals) + 1;
    const excluded = inferredRecords - ordinals.size;
    const current = inferredByRun.get(file.first_ingest_run_id) ?? { records: 0, excluded: 0 };
    current.records += inferredRecords;
    current.excluded += excluded;
    inferredByRun.set(file.first_ingest_run_id, current);
  }

  for (const run of runs.filter((candidate) => candidate.status === "succeeded")) {
    const inferred = inferredByRun.get(run.id) ?? { records: 0, excluded: 0 };
    if (run.registered_file_count > 0 && inferred.records > run.discovered_count) {
      addError(
        errors,
        "record_ordinal_range_mismatch",
        `Ingest run ${run.id} has persisted ordinals outside its discovered-record total.`,
      );
    }
    if (run.registered_file_count > 0 && inferred.excluded > run.excluded_count) {
      addError(
        errors,
        "record_ordinal_gap_mismatch",
        `Ingest run ${run.id} has more internal ordinal gaps than its excluded-record count permits.`,
      );
    }
  }
}

function sqliteBoolean(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function validateFingerprints(
  connection: SqliteConnection,
  errors: EvidenceValidationIssue[],
): number {
  const spotify = connection
    .prepare<SpotifyFingerprintRow>(
      `SELECT source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri,
              artist_name, album_name, track_name, reason_start, reason_end, shuffle,
              skipped, offline, offline_at_epoch_ms, source_fingerprint_sha256
       FROM spotify_play_source
       ORDER BY source_record_id`,
    )
    .all();
  for (const row of spotify) {
    const expected = fingerprintSpotifyTrackRecord({
      albumName: row.album_name,
      artistName: row.artist_name,
      msPlayed: row.ms_played,
      offline: sqliteBoolean(row.offline),
      offlineTimestamp: row.offline_at_epoch_ms,
      reasonEnd: row.reason_end,
      reasonStart: row.reason_start,
      shuffle: sqliteBoolean(row.shuffle) ?? false,
      skipped: sqliteBoolean(row.skipped),
      spotifyTrackUri: row.spotify_track_uri,
      startedAtEpochMs: row.stopped_at_epoch_ms - row.ms_played,
      stoppedAtEpochMs: row.stopped_at_epoch_ms,
      trackName: row.track_name,
    });
    if (expected !== row.source_fingerprint_sha256) {
      addError(
        errors,
        "spotify_fingerprint_mismatch",
        `Spotify source record ${row.source_record_id} does not match its stored fingerprint.`,
      );
    }
  }

  const lastfm = connection
    .prepare<LastfmFingerprintRow>(
      `SELECT source_record_id, scrobbled_at_epoch_ms, artist_name, album_name, track_name,
              artist_musicbrainz_id, release_musicbrainz_id, recording_musicbrainz_id,
              loved, source_fingerprint_sha256
       FROM lastfm_scrobble_source
       ORDER BY source_record_id`,
    )
    .all();
  for (const row of lastfm) {
    const expected = fingerprintLastfmScrobble({
      albumName: row.album_name,
      artistMusicbrainzId: row.artist_musicbrainz_id,
      artistName: row.artist_name,
      loved: sqliteBoolean(row.loved),
      recordingMusicbrainzId: row.recording_musicbrainz_id,
      releaseMusicbrainzId: row.release_musicbrainz_id,
      scrobbledAtEpochMs: row.scrobbled_at_epoch_ms,
      trackName: row.track_name,
    });
    if (expected !== row.source_fingerprint_sha256) {
      addError(
        errors,
        "lastfm_fingerprint_mismatch",
        `Last.fm evidence record ${row.source_record_id} does not match its stored fingerprint.`,
      );
    }
  }

  const badOccurrenceCount =
    count(
      connection,
      `SELECT count(*) AS count
     FROM source_record AS source
     LEFT JOIN lastfm_scrobble_occurrence AS occurrence ON occurrence.source_record_id = source.id
     LEFT JOIN lastfm_scrobble_source AS evidence
       ON evidence.source_record_id = occurrence.lastfm_scrobble_source_record_id
     WHERE source.source_kind = 'lastfm'
       AND (occurrence.source_record_id IS NULL OR evidence.source_record_id IS NULL)`,
    ) +
    count(
      connection,
      `SELECT count(*) AS count
       FROM lastfm_scrobble_source AS evidence
       JOIN source_record AS parent ON parent.id = evidence.source_record_id
       LEFT JOIN lastfm_scrobble_occurrence AS occurrence
         ON occurrence.lastfm_scrobble_source_record_id = evidence.source_record_id
       WHERE parent.source_kind <> 'lastfm' OR occurrence.source_record_id IS NULL`,
    ) +
    count(
      connection,
      `SELECT count(*) AS count
       FROM lastfm_scrobble_occurrence AS occurrence
       JOIN source_record AS source ON source.id = occurrence.source_record_id
       WHERE source.source_kind <> 'lastfm'`,
    );
  if (badOccurrenceCount > 0) {
    addError(
      errors,
      "lastfm_occurrence_invalid",
      `${badOccurrenceCount} Last.fm occurrence link(s) do not resolve to compatible evidence.`,
    );
  }

  const badSpotifyShapeCount = count(
    connection,
    `SELECT count(*) AS count
     FROM source_record AS source
     LEFT JOIN spotify_play_source AS spotify ON spotify.source_record_id = source.id
     WHERE (source.source_kind = 'spotify' AND spotify.source_record_id IS NULL)
        OR (source.source_kind <> 'spotify' AND spotify.source_record_id IS NOT NULL)`,
  );
  if (badSpotifyShapeCount > 0) {
    addError(
      errors,
      "spotify_evidence_shape_invalid",
      `${badSpotifyShapeCount} source record(s) do not have the required Spotify evidence shape.`,
    );
  }

  return spotify.length + lastfm.length;
}

/** Validates aggregate API-run metadata, cursor ownership, and API/export occurrence provenance. */
function validateLastfmSynchronization(
  connection: SqliteConnection,
  errors: EvidenceValidationIssue[],
): void {
  const invalidApiRunMetadata = count(
    connection,
    `SELECT count(*) AS count
       FROM ingest_run AS run
       LEFT JOIN lastfm_api_sync_metadata AS metadata ON metadata.ingest_run_id = run.id
      WHERE run.command_type = 'lastfm_api_sync'
        AND (
          (run.status = 'succeeded' AND metadata.ingest_run_id IS NULL)
          OR (run.status <> 'succeeded' AND metadata.ingest_run_id IS NOT NULL)
          OR (metadata.ingest_run_id IS NOT NULL
              AND (metadata.completed_track_count < run.discovered_count
                   OR metadata.completed_track_count < run.accepted_count
                   OR metadata.page_count = 0))
        )`,
  );
  if (invalidApiRunMetadata > 0) {
    addError(
      errors,
      "lastfm_api_run_metadata_invalid",
      `${invalidApiRunMetadata} Last.fm API sync run(s) have incompatible aggregate response metadata.`,
    );
  }

  const invalidCursorCount = count(
    connection,
    `SELECT count(*) AS count
       FROM sync_cursor AS cursor
       LEFT JOIN ingest_run AS run ON run.id = cursor.last_successful_ingest_run_id
       LEFT JOIN lastfm_api_sync_metadata AS metadata ON metadata.ingest_run_id = run.id
       LEFT JOIN (
         SELECT source.ingest_run_id, max(evidence.scrobbled_at_epoch_ms) AS latest_scrobbled_at_epoch_ms
           FROM source_record AS source
           JOIN lastfm_scrobble_occurrence AS occurrence ON occurrence.source_record_id = source.id
           JOIN lastfm_scrobble_source AS evidence
             ON evidence.source_record_id = occurrence.lastfm_scrobble_source_record_id
          GROUP BY source.ingest_run_id
       ) AS completed ON completed.ingest_run_id = run.id
      WHERE cursor.source_type <> 'lastfm_api'
         OR run.id IS NULL
         OR run.command_type <> 'lastfm_api_sync'
         OR run.status <> 'succeeded'
         OR metadata.ingest_run_id IS NULL
         OR cursor.updated_at_epoch_ms < run.completed_at_epoch_ms
         OR (completed.latest_scrobbled_at_epoch_ms IS NOT NULL
             AND cursor.boundary_epoch_ms <> completed.latest_scrobbled_at_epoch_ms)`,
  );
  if (invalidCursorCount > 0) {
    addError(
      errors,
      "lastfm_sync_cursor_invalid",
      `${invalidCursorCount} Last.fm sync cursor(s) do not reference a wholly successful API sync run.`,
    );
  }

  const invalidOccurrenceOrigins = count(
    connection,
    `SELECT count(*) AS count
       FROM lastfm_scrobble_occurrence AS occurrence
       JOIN source_record AS source ON source.id = occurrence.source_record_id
       JOIN ingest_run AS run ON run.id = source.ingest_run_id
       JOIN lastfm_scrobble_source AS evidence
         ON evidence.source_record_id = occurrence.lastfm_scrobble_source_record_id
      WHERE (run.command_type = 'lastfm_export_import' AND occurrence.source_origin <> 'export')
         OR (run.command_type = 'lastfm_api_sync' AND occurrence.source_origin <> 'api')
         OR (occurrence.source_origin = 'export' AND evidence.source_origin <> 'export')
         OR (occurrence.source_origin = 'api'
             AND evidence.source_origin = 'api'
             AND occurrence.source_record_id <> evidence.source_record_id)`,
  );
  if (invalidOccurrenceOrigins > 0) {
    addError(
      errors,
      "lastfm_api_export_overlap_invalid",
      `${invalidOccurrenceOrigins} Last.fm API/export occurrence link(s) have incompatible provenance.`,
    );
  }
}

function validateRejections(
  connection: SqliteConnection,
  errors: EvidenceValidationIssue[],
): readonly RejectionRow[] {
  const rejections = connection
    .prepare<RejectionRow>(
      `SELECT id, ingest_run_id, source_file_id, source_ordinal, source_kind,
              error_code, safe_diagnostic_summary
       FROM rejected_source_record
       ORDER BY id`,
    )
    .all();
  const expectedSummary = IngestIssueSummary.rejected_source_record;
  const allowedCodes = {
    lastfm: new Set<string>(Object.values(LastfmRecordRejectionReason)),
    spotify: new Set<string>(Object.values(SpotifyRecordRejectionReason)),
  } as const;
  for (const rejection of rejections) {
    if (rejection.safe_diagnostic_summary !== expectedSummary) {
      addError(
        errors,
        "rejection_summary_unsafe",
        `Rejected source record ${rejection.id} does not use the approved safe diagnostic summary.`,
      );
    }
    if (
      (rejection.source_kind !== "lastfm" && rejection.source_kind !== "spotify") ||
      !allowedCodes[rejection.source_kind].has(rejection.error_code)
    ) {
      addError(
        errors,
        "rejection_code_invalid",
        `Rejected source record ${rejection.id} does not use an approved safe error code.`,
      );
    }
    if (rejection.source_file_id === null || rejection.source_ordinal === null) {
      addError(
        errors,
        "rejection_provenance_incomplete",
        `Rejected source record ${rejection.id} is missing file or ordinal provenance.`,
      );
    }
  }
  return rejections;
}

function validateCanonicalInterpretations(
  connection: SqliteConnection,
  errors: EvidenceValidationIssue[],
): void {
  const unlinkedEvidence = count(
    connection,
    `SELECT count(*) AS count
       FROM source_record AS source
       LEFT JOIN source_identity_resolution AS resolution ON resolution.source_record_id = source.id
       LEFT JOIN listening_event_source AS link ON link.source_record_id = source.id
      WHERE resolution.source_record_id IS NULL OR link.source_record_id IS NULL`,
  );
  if (unlinkedEvidence > 0) {
    addError(
      errors,
      "canonical_interpretation_missing",
      `${unlinkedEvidence} accepted source record(s) lack an identity resolution or canonical event source link.`,
    );
  }

  const emptyEvents = count(
    connection,
    `SELECT count(*) AS count
       FROM (
         SELECT event.id
           FROM listening_event AS event
           LEFT JOIN listening_event_source AS link ON link.listening_event_id = event.id
          WHERE event.event_status <> 'superseded'
          GROUP BY event.id
         HAVING count(link.source_record_id) = 0
       )`,
  );
  if (emptyEvents > 0) {
    addError(
      errors,
      "canonical_event_without_source",
      `${emptyEvents} canonical event(s) have no source evidence link.`,
    );
  }

  const invalidStatuses = count(
    connection,
    `SELECT count(*) AS count
       FROM source_identity_resolution AS resolution
       JOIN listening_event_source AS link ON link.source_record_id = resolution.source_record_id
       JOIN listening_event AS event ON event.id = link.listening_event_id
      WHERE (resolution.resolution_kind = 'new_unresolved'
             AND event.event_status NOT IN ('unresolved', 'superseded'))
         OR (resolution.resolution_kind <> 'new_unresolved'
             AND event.event_status = 'unresolved')`,
  );
  if (invalidStatuses > 0) {
    addError(
      errors,
      "canonical_unresolved_state_invalid",
      `${invalidStatuses} source interpretation(s) disagree with their canonical unresolved state.`,
    );
  }

  const invalidSupersededEvents = count(
    connection,
    `SELECT count(*) AS count
       FROM listening_event AS event
      WHERE (event.event_status = 'superseded' AND EXISTS (
               SELECT 1 FROM listening_event_source AS link WHERE link.listening_event_id = event.id
             ))
         OR (event.event_status <> 'superseded' AND event.superseded_by_event_id IS NOT NULL)`,
  );
  if (invalidSupersededEvents > 0) {
    addError(
      errors,
      "canonical_event_lineage_invalid",
      `${invalidSupersededEvents} canonical event(s) have invalid supersession lineage.`,
    );
  }
}

function validateIdentityGraph(
  connection: SqliteConnection,
  errors: EvidenceValidationIssue[],
): void {
  const invalidEntities = count(
    connection,
    `SELECT count(*) AS count
       FROM music_entity AS entity
       LEFT JOIN artist ON artist.id = entity.id
       LEFT JOIN release ON release.id = entity.id
       LEFT JOIN track ON track.id = entity.id
      WHERE (entity.entity_type = 'artist' AND (artist.id IS NULL OR release.id IS NOT NULL OR track.id IS NOT NULL))
         OR (entity.entity_type = 'release' AND (release.id IS NULL OR artist.id IS NOT NULL OR track.id IS NOT NULL))
         OR (entity.entity_type = 'track' AND (track.id IS NULL OR artist.id IS NOT NULL OR release.id IS NOT NULL))`,
  );
  if (invalidEntities > 0) {
    addError(
      errors,
      "identity_graph_entity_invalid",
      `${invalidEntities} identity entity node(s) have an invalid subtype shape.`,
    );
  }
  const invalidResolutions = count(
    connection,
    `SELECT count(*) AS count
       FROM source_identity_resolution AS resolution
       JOIN track ON track.id = resolution.track_id
      WHERE resolution.artist_id <> track.artist_id
         OR (resolution.release_id IS NOT NULL AND resolution.release_id IS NOT track.release_id)`,
  );
  if (invalidResolutions > 0) {
    addError(
      errors,
      "identity_resolution_graph_invalid",
      `${invalidResolutions} source identity resolution(s) disagree with their track graph.`,
    );
  }
  const invalidIdentifierOwners = count(
    connection,
    `SELECT count(*) AS count
       FROM music_identifier AS identifier
       JOIN music_entity AS entity ON entity.id = identifier.entity_id
      WHERE (identifier.namespace IN ('spotify_artist_uri', 'musicbrainz_artist_id') AND entity.entity_type <> 'artist')
         OR (identifier.namespace IN ('spotify_release_uri', 'musicbrainz_release_id') AND entity.entity_type <> 'release')
         OR (identifier.namespace IN ('spotify_track_uri', 'musicbrainz_recording_id') AND entity.entity_type <> 'track')`,
  );
  if (invalidIdentifierOwners > 0) {
    addError(
      errors,
      "identity_identifier_owner_invalid",
      `${invalidIdentifierOwners} strong identifier(s) belong to an incompatible identity type.`,
    );
  }
  const invalidConflicts = count(
    connection,
    `SELECT count(*) AS count
       FROM identity_resolution_conflict AS conflict
       JOIN music_entity AS strong_entity ON strong_entity.id = conflict.strong_entity_id
      JOIN music_entity AS conflicting_entity ON conflicting_entity.id = conflict.conflicting_entity_id
      WHERE strong_entity.entity_type <> conflict.entity_type
         OR conflicting_entity.entity_type <> conflict.entity_type`,
  );
  if (invalidConflicts > 0) {
    addError(
      errors,
      "identity_conflict_invalid",
      `${invalidConflicts} recorded identifier conflict(s) have incompatible identity graph nodes.`,
    );
  }

  const unresolvedStrongIdentifiers = count(
    connection,
    `WITH RECURSIVE
       active_manual_merge AS (
         SELECT object_entity_id, subject_entity_id
           FROM identity_decision
          WHERE decision_type = 'merge'
            AND NOT EXISTS (
              SELECT 1
                FROM identity_decision AS superseding
               WHERE superseding.supersedes_decision_id = identity_decision.id
            )
       ),
       effective_entity (original_id, entity_id) AS (
         SELECT id, id FROM music_entity
         UNION
         SELECT effective_entity.original_id, active_manual_merge.subject_entity_id
           FROM effective_entity
           JOIN active_manual_merge
             ON active_manual_merge.object_entity_id = effective_entity.entity_id
       ),
       source_identifier AS (
         SELECT resolution.source_record_id, 'track' AS entity_type,
                resolution.track_id AS resolved_entity_id,
                'spotify_track_uri' AS namespace, spotify.spotify_track_uri AS identifier_value
           FROM source_identity_resolution AS resolution
           JOIN spotify_play_source AS spotify ON spotify.source_record_id = resolution.source_record_id
         UNION ALL
         SELECT resolution.source_record_id, 'artist', resolution.artist_id,
                'musicbrainz_artist_id', lastfm.artist_musicbrainz_id
           FROM source_identity_resolution AS resolution
           JOIN lastfm_scrobble_occurrence AS occurrence
             ON occurrence.source_record_id = resolution.source_record_id
           JOIN lastfm_scrobble_source AS lastfm
             ON lastfm.source_record_id = occurrence.lastfm_scrobble_source_record_id
          WHERE lastfm.artist_musicbrainz_id IS NOT NULL
         UNION ALL
         SELECT resolution.source_record_id, 'release', resolution.release_id,
                'musicbrainz_release_id', lastfm.release_musicbrainz_id
           FROM source_identity_resolution AS resolution
           JOIN lastfm_scrobble_occurrence AS occurrence
             ON occurrence.source_record_id = resolution.source_record_id
           JOIN lastfm_scrobble_source AS lastfm
             ON lastfm.source_record_id = occurrence.lastfm_scrobble_source_record_id
          WHERE lastfm.release_musicbrainz_id IS NOT NULL
         UNION ALL
         SELECT resolution.source_record_id, 'track', resolution.track_id,
                'musicbrainz_recording_id', lastfm.recording_musicbrainz_id
           FROM source_identity_resolution AS resolution
           JOIN lastfm_scrobble_occurrence AS occurrence
             ON occurrence.source_record_id = resolution.source_record_id
           JOIN lastfm_scrobble_source AS lastfm
             ON lastfm.source_record_id = occurrence.lastfm_scrobble_source_record_id
          WHERE lastfm.recording_musicbrainz_id IS NOT NULL
       )
       SELECT count(*) AS count
         FROM source_identifier AS source_identifier
         LEFT JOIN music_identifier AS identifier
           ON identifier.namespace = source_identifier.namespace
          AND identifier.identifier_value = source_identifier.identifier_value
        WHERE identifier.id IS NULL
           OR NOT EXISTS (
             SELECT 1
               FROM effective_entity AS resolved_entity
               JOIN effective_entity AS identifier_entity
                 ON identifier_entity.entity_id = resolved_entity.entity_id
              WHERE resolved_entity.original_id = source_identifier.resolved_entity_id
                AND identifier_entity.original_id = identifier.entity_id
           )
              AND NOT EXISTS (
                SELECT 1
                  FROM identity_resolution_conflict AS conflict
                 WHERE conflict.source_record_id = source_identifier.source_record_id
                   AND conflict.entity_type = source_identifier.entity_type
                   AND ((conflict.strong_entity_id = identifier.entity_id
                         AND conflict.conflicting_entity_id = source_identifier.resolved_entity_id)
                     OR (conflict.strong_entity_id = source_identifier.resolved_entity_id
                         AND conflict.conflicting_entity_id = identifier.entity_id))
              )`,
  );
  if (unresolvedStrongIdentifiers > 0) {
    addError(
      errors,
      "identity_strong_identifier_conflict_unresolved",
      `${unresolvedStrongIdentifiers} strong source identifier(s) do not resolve to their identity or an explicit conflict.`,
    );
  }
}

function validateDecisionLineage(
  connection: SqliteConnection,
  errors: EvidenceValidationIssue[],
): void {
  const invalidLineage = count(
    connection,
    `SELECT count(*) AS count
       FROM reconciliation_decision AS decision
       LEFT JOIN reconciliation_decision AS replacement ON replacement.id = decision.superseded_by_decision_id
      WHERE (decision.decision_state = 'active' AND decision.superseded_by_decision_id IS NOT NULL)
         OR (decision.decision_state = 'superseded' AND (replacement.id IS NULL OR replacement.reconciliation_candidate_id <> decision.reconciliation_candidate_id))`,
  );
  const multipleActive = count(
    connection,
    `SELECT count(*) AS count FROM (
       SELECT reconciliation_candidate_id
         FROM reconciliation_decision
        WHERE decision_state = 'active'
        GROUP BY reconciliation_candidate_id
       HAVING count(*) > 1
     )`,
  );
  const invalidAutoAccept = count(
    connection,
    `SELECT count(*) AS count
       FROM reconciliation_decision AS decision
       LEFT JOIN listening_event AS source_event ON source_event.id = decision.source_listening_event_id
       LEFT JOIN listening_event AS target_event ON target_event.id = decision.target_listening_event_id
      WHERE decision.decision = 'auto_accept'
        AND decision.decision_state = 'active'
        AND (source_event.id IS NULL OR target_event.id IS NULL
             OR source_event.event_status <> 'superseded'
             OR source_event.superseded_by_event_id <> target_event.id
             OR NOT EXISTS (
               SELECT 1 FROM listening_event_source AS link
                WHERE link.listening_event_id = target_event.id
                  AND link.reconciliation_candidate_id = decision.reconciliation_candidate_id
                  AND link.evidence_role = 'cross_source_match'
             ))`,
  );
  if (invalidLineage + multipleActive + invalidAutoAccept > 0) {
    addError(
      errors,
      "reconciliation_decision_lineage_invalid",
      `${invalidLineage + multipleActive + invalidAutoAccept} reconciliation decision lineage invariant(s) failed.`,
    );
  }

  const invalidManualReconciliation = count(
    connection,
    `WITH current_manual_decision AS (
       SELECT manual.decision_key, manual.reconciliation_candidate_id, manual.decision,
              manual.source_listening_event_id, manual.target_listening_event_id,
              manual.source_event_status,
              row_number() OVER (
                PARTITION BY manual.reconciliation_candidate_id
                ORDER BY artifact.imported_at_epoch_ms DESC, manual.rowid DESC
              ) AS decision_rank
         FROM manual_reconciliation_decision AS manual
         JOIN manual_decision_artifact AS artifact ON artifact.decision_key = manual.decision_key
     )
     SELECT count(*) AS count
       FROM manual_reconciliation_decision AS manual
       JOIN manual_decision_artifact AS artifact ON artifact.decision_key = manual.decision_key
       LEFT JOIN current_manual_decision AS current
         ON current.decision_key = manual.decision_key
        AND current.decision_rank = 1
       LEFT JOIN reconciliation_candidate AS candidate
         ON candidate.id = manual.reconciliation_candidate_id
       LEFT JOIN listening_event AS source_event ON source_event.id = manual.source_listening_event_id
       LEFT JOIN listening_event AS target_event ON target_event.id = manual.target_listening_event_id
      WHERE artifact.decision_type <> manual.decision
         OR (current.decision_key IS NOT NULL AND current.decision = 'reject'
             AND (manual.source_listening_event_id IS NOT NULL
                  OR manual.target_listening_event_id IS NOT NULL
                  OR manual.source_event_status IS NOT NULL
                  OR candidate.candidate_state <> 'manually_rejected'))
         OR (current.decision_key IS NOT NULL AND current.decision = 'accept'
             AND (source_event.id IS NULL OR target_event.id IS NULL
                  OR source_event.event_status <> 'superseded'
                  OR source_event.superseded_by_event_id <> target_event.id
                  OR candidate.candidate_state <> 'manually_accepted'
                  OR NOT EXISTS (
                    SELECT 1
                      FROM listening_event_source AS spotify_link
                     WHERE spotify_link.listening_event_id = target_event.id
                       AND spotify_link.source_record_id = candidate.spotify_source_record_id
                  )
                  OR NOT EXISTS (
                    SELECT 1
                      FROM listening_event_source AS lastfm_link
                     WHERE lastfm_link.listening_event_id = target_event.id
                       AND lastfm_link.source_record_id = candidate.lastfm_source_record_id
                       AND lastfm_link.evidence_role = 'cross_source_match'
                       AND lastfm_link.reconciliation_candidate_id = candidate.id)))`,
  );
  if (invalidManualReconciliation > 0) {
    addError(
      errors,
      "manual_reconciliation_decision_lineage_invalid",
      `${invalidManualReconciliation} manual reconciliation decision lineage invariant(s) failed.`,
    );
  }

  const invalidIdentityLineage = count(
    connection,
    `SELECT count(*) AS count
       FROM identity_decision AS decision
       LEFT JOIN identity_decision AS superseded ON superseded.id = decision.supersedes_decision_id
       LEFT JOIN music_entity AS subject ON subject.id = decision.subject_entity_id
       LEFT JOIN music_entity AS object ON object.id = decision.object_entity_id
       LEFT JOIN manual_identity_decision AS manual ON manual.identity_decision_id = decision.id
       LEFT JOIN manual_decision_artifact AS artifact ON artifact.decision_key = manual.decision_key
      WHERE (decision.decision_type IN ('merge', 'split')
             AND (subject.entity_type <> object.entity_type OR object.id IS NULL))
         OR (decision.supersedes_decision_id IS NOT NULL
             AND (decision.decision_type <> 'split'
                  OR superseded.id IS NULL
                  OR superseded.decision_type <> 'merge'
                  OR decision.subject_entity_id <> superseded.subject_entity_id
                  OR decision.object_entity_id <> superseded.object_entity_id))
         OR (manual.decision_key IS NOT NULL AND artifact.decision_type <> decision.decision_type)`,
  );
  if (invalidIdentityLineage > 0) {
    addError(
      errors,
      "identity_decision_lineage_invalid",
      `${invalidIdentityLineage} identity decision lineage invariant(s) failed.`,
    );
  }
}

function validateRuleVersions(
  connection: SqliteConnection,
  errors: EvidenceValidationIssue[],
): void {
  const invalidVersions = count(
    connection,
    `SELECT count(*) AS count FROM (
       SELECT resolution_rule_version AS version FROM source_identity_resolution
       UNION ALL SELECT normalization_version FROM source_identity_resolution
       UNION ALL SELECT reconciliation_rule_version FROM listening_event
       UNION ALL SELECT rule_version FROM reconciliation_candidate
       UNION ALL SELECT generation_rule_version FROM cross_source_candidate_generation
       UNION ALL SELECT policy_rule_version FROM reconciliation_decision
       UNION ALL SELECT artifact_version FROM manual_decision_artifact
     ) WHERE length(trim(version)) = 0`,
  );
  if (invalidVersions > 0) {
    addError(
      errors,
      "reconciliation_rule_version_invalid",
      `${invalidVersions} identity or reconciliation rows have an empty rule version.`,
    );
  }
}

function archiveBaselineFindings(connection: SqliteConnection): readonly EvidenceValidationIssue[] {
  const metrics = [
    {
      name: "Spotify accepted evidence",
      actual: count(connection, "SELECT count(*) AS count FROM spotify_play_source"),
      expected: ARCHIVE_BASELINE.spotifyAccepted,
    },
    {
      name: "Spotify duplicate evidence",
      actual: count(
        connection,
        `SELECT coalesce(sum(group_size - 1), 0) AS count
         FROM (
           SELECT count(*) AS group_size
           FROM spotify_play_source
           GROUP BY source_fingerprint_sha256
         )`,
      ),
      expected: ARCHIVE_BASELINE.spotifyDuplicated,
    },
    {
      name: "Spotify excluded records",
      actual: count(
        connection,
        "SELECT coalesce(sum(excluded_count), 0) AS count FROM ingest_run WHERE command_type = 'spotify_import' AND status = 'succeeded'",
      ),
      expected: ARCHIVE_BASELINE.spotifyExcluded,
    },
    {
      name: "Spotify rejected records",
      actual: count(
        connection,
        "SELECT count(*) AS count FROM rejected_source_record WHERE source_kind = 'spotify'",
      ),
      expected: ARCHIVE_BASELINE.spotifyRejected,
    },
    {
      name: "Last.fm accepted occurrences",
      actual: count(connection, "SELECT count(*) AS count FROM lastfm_scrobble_occurrence"),
      expected: ARCHIVE_BASELINE.lastfmAccepted,
    },
    {
      name: "Last.fm duplicate occurrences",
      actual: count(
        connection,
        "SELECT count(*) AS count FROM lastfm_scrobble_occurrence WHERE source_record_id <> lastfm_scrobble_source_record_id",
      ),
      expected: ARCHIVE_BASELINE.lastfmDuplicated,
    },
    {
      name: "Last.fm rejected records",
      actual: count(
        connection,
        "SELECT count(*) AS count FROM rejected_source_record WHERE source_kind = 'lastfm'",
      ),
      expected: ARCHIVE_BASELINE.lastfmRejected,
    },
  ] as const;

  return metrics
    .filter((metric) => metric.actual !== metric.expected)
    .map((metric) => ({
      code: "archive_baseline_deviation",
      message: `${metric.name} is ${metric.actual}; the documented 2026-07-17 baseline is ${metric.expected}. This is a finding, not an invariant failure.`,
    }));
}

/** Validates persisted historical evidence without changing source files or database state. */
export function validateEvidenceLayer(
  connection: SqliteConnection,
  evidenceRoot: string,
): EvidenceValidationResult {
  return connection.transaction((snapshotConnection) => {
    const errors: EvidenceValidationIssue[] = [];
    const files = validateSourceFiles(snapshotConnection, evidenceRoot, errors);
    const runs = validateIngestRuns(snapshotConnection, errors);
    validateSourceOwnership(snapshotConnection, errors);
    validateOrdinals(snapshotConnection, files, runs, errors);
    const fingerprints = validateFingerprints(snapshotConnection, errors);
    validateLastfmSynchronization(snapshotConnection, errors);
    const rejections = validateRejections(snapshotConnection, errors);
    validateCanonicalInterpretations(snapshotConnection, errors);
    validateIdentityGraph(snapshotConnection, errors);
    validateDecisionLineage(snapshotConnection, errors);
    validateRuleVersions(snapshotConnection, errors);
    const integrity = snapshotConnection.checkIntegrity();
    if (!integrity.ok) {
      addError(
        errors,
        "database_integrity_failed",
        `SQLite reported ${integrity.messages.length} integrity message(s) and ${integrity.foreignKeyViolations.length} foreign-key violation(s).`,
      );
    }

    return {
      ok: errors.length === 0,
      checked: {
        sourceFiles: files.length,
        ingestRuns: runs.length,
        sourceRecords: count(snapshotConnection, "SELECT count(*) AS count FROM source_record"),
        rejectedRecords: rejections.length,
        fingerprints,
        canonicalEvents: count(snapshotConnection, "SELECT count(*) AS count FROM listening_event"),
        reconciliationCandidates: count(
          snapshotConnection,
          "SELECT count(*) AS count FROM reconciliation_candidate",
        ),
      },
      integrity,
      errors,
      findings: archiveBaselineFindings(snapshotConnection),
    };
  }, "deferred");
}
