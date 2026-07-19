import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import type { IntegrityCheckResult, SqliteConnection, SqliteRow } from "../db/connection.ts";
import { IngestIssueSummary } from "../importers/contracts.ts";
import {
  fingerprintLastfmScrobble,
  LastfmRecordRejectionReason,
} from "../importers/lastfm-export/boundary.ts";
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
    const candidate = path.resolve(resolvedRoot, file.relative_path);
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

  const badOccurrenceCount = count(
    connection,
    `SELECT count(*) AS count
     FROM source_record AS source
     LEFT JOIN lastfm_scrobble_occurrence AS occurrence ON occurrence.source_record_id = source.id
     LEFT JOIN lastfm_scrobble_source AS evidence
       ON evidence.source_record_id = occurrence.lastfm_scrobble_source_record_id
     WHERE source.source_kind = 'lastfm'
       AND (occurrence.source_record_id IS NULL OR evidence.source_record_id IS NULL
            OR occurrence.source_origin <> evidence.source_origin)`,
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
    const rejections = validateRejections(snapshotConnection, errors);
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
      },
      integrity,
      errors,
      findings: archiveBaselineFindings(snapshotConnection),
    };
  }, "deferred");
}
