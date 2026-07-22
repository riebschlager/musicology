import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";

import { runValidationCommand } from "../../../src/cli/validate.ts";
import { openSqliteConnection } from "../../../src/db/better-sqlite3.ts";
import type {
  PreparedStatement,
  SqliteConnection,
  SqliteRow,
  TransactionMode,
} from "../../../src/db/connection.ts";
import {
  IngestIssueCode,
  IngestIssueSummary,
  SourceEvidenceIngestCommand,
} from "../../../src/importers/contracts.ts";
import { fingerprintLastfmScrobble } from "../../../src/importers/lastfm-export/boundary.ts";
import { importLastfmExportFiles } from "../../../src/importers/lastfm-export/persistence.ts";
import { runIngestLifecycle } from "../../../src/importers/lifecycle.ts";
import { importSpotifyFiles } from "../../../src/importers/spotify/persistence.ts";
import { createCanonicalEvents } from "../../../src/identity/events.ts";
import { resolveSourceIdentities } from "../../../src/identity/resolution.ts";
import { persistLastfmApiPages } from "../../../src/lastfm/persistence.ts";
import { fingerprintLastfmSyncScope, planLastfmSync } from "../../../src/lastfm/sync-plan.ts";
import { synchronizeLastfm } from "../../../src/lastfm/sync.ts";
import { validateEvidenceLayer } from "../../../src/validation/evidence.ts";
import {
  buildLastfmScrobbleFixture,
  buildSpotifyEpisodeFixture,
  buildSpotifyTrackFixture,
} from "../../fixtures/index.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

const PRIVATE_SENTINEL = "private-source-value-must-not-escape";

function importValidSyntheticEvidence(workspace: TemporaryTestWorkspace): {
  readonly lastfmPath: string;
  readonly spotifyPath: string;
} {
  const spotifyPath = workspace.writeJsonFixture("spotify/Streaming_History_Audio_2026_0.json", [
    buildSpotifyTrackFixture(),
    buildSpotifyEpisodeFixture(),
    buildSpotifyTrackFixture({ ms_played: "invalid" }),
    buildSpotifyEpisodeFixture(),
  ]);
  const lastfmPath = workspace.writeJsonFixture("lastfm/history.json", [
    buildLastfmScrobbleFixture(),
    buildLastfmScrobbleFixture({ timestamp: "invalid" }),
  ]);

  importSpotifyFiles({
    candidatePaths: [spotifyPath],
    connection: workspace.connection,
    evidenceRoot: workspace.configuration.paths.inputsDirectory,
    now: () => 1_800_000_000_000,
    schemaVersion: "4",
  });
  importLastfmExportFiles({
    candidatePaths: [lastfmPath],
    connection: workspace.connection,
    evidenceRoot: workspace.configuration.paths.inputsDirectory,
    now: () => 1_800_000_001_000,
    schemaVersion: "4",
  });
  resolveSourceIdentities(workspace.connection, { now: () => 1_800_000_001_500 });
  createCanonicalEvents(workspace.connection);
  return { lastfmPath, spotifyPath };
}

describe("evidence-layer validation", () => {
  it("validates API sync cursor metadata and API/export overlap provenance without exposing private values", async () => {
    await withTemporaryTestWorkspace(async (workspace) => {
      const scopeFingerprintSha256 = fingerprintLastfmSyncScope("synthetic-validation-listener");
      const scrobble = buildLastfmScrobbleFixture();
      const page = {
        completedTracks: [
          {
            albumName: scrobble.album_name,
            artistMusicbrainzId: scrobble.artist_musicbrainz_id,
            artistName: scrobble.artist_name,
            loved: scrobble.loved,
            recordingMusicbrainzId: scrobble.recording_musicbrainz_id,
            releaseMusicbrainzId: scrobble.release_musicbrainz_id,
            scrobbledAtEpochMs: scrobble.timestamp,
            trackName: scrobble.track_name,
          },
        ],
        ignoredNowPlayingCount: 0,
        pagination: { page: 1, perPage: 1, total: 1, totalPages: 1 },
      } as const;
      await synchronizeLastfm({
        connection: workspace.connection,
        fetcher: {
          async *getRecentTracksPages() {
            yield page;
          },
        },
        now: () => 2_000_000_000_000,
        plan: planLastfmSync(workspace.connection, {
          initialFromEpochMs: 0,
          scopeFingerprintSha256,
        }),
        schemaVersion: "11",
        scopeFingerprintSha256,
      });

      assert.equal(
        validateEvidenceLayer(workspace.connection, workspace.configuration.paths.inputsDirectory)
          .ok,
        true,
      );

      workspace.connection
        .prepare("UPDATE sync_cursor SET boundary_epoch_ms = boundary_epoch_ms - 1")
        .run();
      const boundaryValidation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(boundaryValidation.ok, false);
      assert.ok(
        boundaryValidation.errors.some((error) => error.code === "lastfm_sync_cursor_invalid"),
      );
      assert.equal(JSON.stringify(boundaryValidation).includes(PRIVATE_SENTINEL), false);

      workspace.connection
        .prepare("UPDATE sync_cursor SET boundary_epoch_ms = ?")
        .run([scrobble.timestamp]);
      workspace.connection
        .prepare(
          `UPDATE ingest_run
             SET completed_at_epoch_ms = completed_at_epoch_ms + 1
           WHERE id = (SELECT last_successful_ingest_run_id FROM sync_cursor LIMIT 1)`,
        )
        .run();
      const cursorValidation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(cursorValidation.ok, false);
      assert.ok(
        cursorValidation.errors.some((error) => error.code === "lastfm_sync_cursor_invalid"),
      );
      assert.equal(JSON.stringify(cursorValidation).includes(PRIVATE_SENTINEL), false);
    });

    withTemporaryTestWorkspace((workspace) => {
      const exportPath = workspace.writeJsonFixture("lastfm/history.json", [
        buildLastfmScrobbleFixture(),
      ]);
      importLastfmExportFiles({
        candidatePaths: [exportPath],
        connection: workspace.connection,
        evidenceRoot: workspace.configuration.paths.inputsDirectory,
        now: () => 10_000,
        schemaVersion: "11",
      });
      const exported = buildLastfmScrobbleFixture();
      persistLastfmApiPages({
        connection: workspace.connection,
        now: () => 20_000,
        pages: [
          {
            completedTracks: [
              {
                albumName: exported.album_name,
                artistMusicbrainzId: exported.artist_musicbrainz_id,
                artistName: exported.artist_name,
                loved: exported.loved,
                recordingMusicbrainzId: exported.recording_musicbrainz_id,
                releaseMusicbrainzId: exported.release_musicbrainz_id,
                scrobbledAtEpochMs: exported.timestamp,
                trackName: exported.track_name,
              },
            ],
            ignoredNowPlayingCount: 0,
            pagination: { page: 1, perPage: 1, total: 1, totalPages: 1 },
          },
        ],
        schemaVersion: "11",
      });
      const distinct = buildLastfmScrobbleFixture({
        timestamp: exported.timestamp + 1_000,
        track_name: "A distinct synthetic API scrobble",
      });
      persistLastfmApiPages({
        connection: workspace.connection,
        now: () => 21_000,
        pages: [
          {
            completedTracks: [
              {
                albumName: distinct.album_name,
                artistMusicbrainzId: distinct.artist_musicbrainz_id,
                artistName: distinct.artist_name,
                loved: distinct.loved,
                recordingMusicbrainzId: distinct.recording_musicbrainz_id,
                releaseMusicbrainzId: distinct.release_musicbrainz_id,
                scrobbledAtEpochMs: distinct.timestamp,
                trackName: distinct.track_name,
              },
            ],
            ignoredNowPlayingCount: 0,
            pagination: { page: 1, perPage: 1, total: 1, totalPages: 1 },
          },
        ],
        schemaVersion: "11",
      });
      workspace.connection
        .prepare(
          `UPDATE lastfm_scrobble_occurrence
              SET lastfm_scrobble_source_record_id = (
                SELECT source_record_id
                  FROM lastfm_scrobble_source
                 WHERE source_origin = 'api'
                 ORDER BY source_record_id DESC
                 LIMIT 1
              )
            WHERE source_origin = 'api'
              AND source_record_id <> lastfm_scrobble_source_record_id`,
        )
        .run();

      const apiLinkValidation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(apiLinkValidation.ok, false);
      assert.ok(
        apiLinkValidation.errors.some(
          (error) => error.code === "lastfm_api_export_overlap_invalid",
        ),
      );
      workspace.connection
        .prepare(
          "UPDATE lastfm_scrobble_occurrence SET source_origin = 'export' WHERE source_origin = 'api'",
        )
        .run();

      const overlapValidation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(overlapValidation.ok, false);
      assert.ok(
        overlapValidation.errors.some(
          (error) => error.code === "lastfm_api_export_overlap_invalid",
        ),
      );
    });
  });

  it("passes valid deterministic synthetic imports and reports archive deviations as findings", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );

      assert.equal(validation.ok, true);
      assert.deepEqual(validation.errors, []);
      assert.deepEqual(validation.checked, {
        sourceFiles: 2,
        ingestRuns: 2,
        sourceRecords: 2,
        rejectedRecords: 2,
        fingerprints: 2,
        canonicalEvents: 2,
        reconciliationCandidates: 0,
      });
      assert.ok(validation.findings.length > 0);
      assert.ok(
        validation.findings.every((finding) => finding.code === "archive_baseline_deviation"),
      );
      assert.equal(validation.integrity.ok, true);

      const command = runValidationCommand({
        connection: workspace.connection,
        evidenceRoot: workspace.configuration.paths.inputsDirectory,
      });
      assert.equal(command.status, "success");
      assert.equal(command.exitCode, 0);
    });
  });

  it("detects a changed registered path without modifying source evidence", () => {
    withTemporaryTestWorkspace((workspace) => {
      const { spotifyPath } = importValidSyntheticEvidence(workspace);
      writeFileSync(spotifyPath, "[]\n", "utf8");

      const before = workspace.connection
        .prepare<{ readonly count: number }>("SELECT count(*) AS count FROM spotify_play_source")
        .get()?.count;
      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      const after = workspace.connection
        .prepare<{ readonly count: number }>("SELECT count(*) AS count FROM spotify_play_source")
        .get()?.count;

      assert.equal(validation.ok, false);
      assert.ok(validation.errors.some((error) => error.code === "source_file_changed"));
      assert.equal(after, before);
    });
  });

  it("resolves an opaque Last.fm locator and detects changed bytes at its private path", () => {
    withTemporaryTestWorkspace((workspace) => {
      const { lastfmPath } = importValidSyntheticEvidence(workspace);
      writeFileSync(lastfmPath, "[]\n", "utf8");

      const before = workspace.connection
        .prepare<{ readonly count: number }>(
          "SELECT count(*) AS count FROM lastfm_scrobble_occurrence",
        )
        .get()?.count;
      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      const after = workspace.connection
        .prepare<{ readonly count: number }>(
          "SELECT count(*) AS count FROM lastfm_scrobble_occurrence",
        )
        .get()?.count;

      assert.equal(validation.ok, false);
      assert.ok(validation.errors.some((error) => error.code === "source_file_changed"));
      assert.equal(after, before);
    });
  });

  it("requires status-compatible, privacy-reviewed ingest-run error summaries", () => {
    withTemporaryTestWorkspace((workspace) => {
      workspace.connection
        .prepare(
          `INSERT INTO ingest_run
            (command_type, started_at_epoch_ms, completed_at_epoch_ms, status,
             schema_version, safe_error_summary)
           VALUES ('spotify_import', 1, 1, 'failed', '4', ?)`,
        )
        .run([IngestIssueSummary[IngestIssueCode.IngestFailed]]);

      const valid = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(valid.ok, true);

      workspace.connection
        .prepare("UPDATE ingest_run SET safe_error_summary = ? WHERE status = 'failed'")
        .run([PRIVATE_SENTINEL]);

      const command = runValidationCommand({
        connection: workspace.connection,
        evidenceRoot: workspace.configuration.paths.inputsDirectory,
      });
      assert.equal(command.status, "error");
      assert.ok(command.errors?.some((error) => error.code === "ingest_run_error_summary_unsafe"));
      assert.equal(JSON.stringify(command).includes(PRIVATE_SENTINEL), false);
    });

    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare("UPDATE ingest_run SET safe_error_summary = ? WHERE status = 'succeeded'")
        .run([PRIVATE_SENTINEL]);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      assert.ok(
        validation.errors.some((error) => error.code === "ingest_run_error_summary_unsafe"),
      );
      assert.equal(JSON.stringify(validation).includes(PRIVATE_SENTINEL), false);
    });
  });

  it("detects incompatible source-file and accepted-record ingest ownership", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      const sourceRecords = workspace.connection
        .prepare<{
          readonly id: number;
          readonly ingest_run_id: number;
          readonly source_kind: string;
        }>("SELECT id, ingest_run_id, source_kind FROM source_record ORDER BY id")
        .all();
      const spotify = sourceRecords.find((record) => record.source_kind === "spotify");
      const lastfm = sourceRecords.find((record) => record.source_kind === "lastfm");
      assert.notEqual(spotify, undefined);
      assert.notEqual(lastfm, undefined);

      workspace.connection
        .prepare("UPDATE source_record SET ingest_run_id = ? WHERE id = ?")
        .run([lastfm?.ingest_run_id ?? 0, spotify?.id ?? 0]);
      workspace.connection
        .prepare("UPDATE source_record SET ingest_run_id = ? WHERE id = ?")
        .run([spotify?.ingest_run_id ?? 0, lastfm?.id ?? 0]);
      workspace.connection
        .prepare(
          `UPDATE source_file
           SET last_ingest_run_id = (
             SELECT id FROM ingest_run WHERE command_type = 'lastfm_export_import'
           )
           WHERE source_type = 'spotify_export'`,
        )
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      const codes = new Set(validation.errors.map((error) => error.code));
      assert.equal(codes.has("source_file_run_link_invalid"), true);
      assert.equal(codes.has("source_record_ownership_invalid"), true);
    });
  });

  it("accepts a source file whose last ingest run is a compatible no-op", () => {
    withTemporaryTestWorkspace((workspace) => {
      const { spotifyPath } = importValidSyntheticEvidence(workspace);
      const summary = importSpotifyFiles({
        candidatePaths: [spotifyPath],
        connection: workspace.connection,
        evidenceRoot: workspace.configuration.paths.inputsDirectory,
        now: () => 1_800_000_002_000,
        schemaVersion: "4",
      });
      assert.equal(summary.noOp, true);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, true);
    });
  });

  it("validates one committed database snapshot during a concurrent import change", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      const concurrentConnection = openSqliteConnection(workspace.configuration.paths.databasePath);
      let changedDuringValidation = false;
      let hookedConnection: SqliteConnection;
      hookedConnection = {
        get databasePath(): string {
          return workspace.connection.databasePath;
        },
        get isOpen(): boolean {
          return workspace.connection.isOpen;
        },
        get isInTransaction(): boolean {
          return workspace.connection.isInTransaction;
        },
        execute(sql: string): void {
          workspace.connection.execute(sql);
        },
        prepare<Row extends SqliteRow = SqliteRow>(sql: string): PreparedStatement<Row> {
          if (!changedDuringValidation && sql === "SELECT * FROM ingest_run ORDER BY id") {
            changedDuringValidation = true;
            concurrentConnection
              .prepare(
                `UPDATE ingest_run
                 SET accepted_count = accepted_count - 1,
                     excluded_count = excluded_count + 1
                 WHERE command_type = 'spotify_import'`,
              )
              .run();
          }
          return workspace.connection.prepare<Row>(sql);
        },
        transaction<T>(operation: (connection: SqliteConnection) => T, mode?: TransactionMode): T {
          return workspace.connection.transaction(() => operation(hookedConnection), mode);
        },
        checkIntegrity() {
          return workspace.connection.checkIntegrity();
        },
        close(): void {
          workspace.connection.close();
        },
      };

      try {
        const snapshotValidation = validateEvidenceLayer(
          hookedConnection,
          workspace.configuration.paths.inputsDirectory,
        );
        assert.equal(changedDuringValidation, true);
        assert.equal(snapshotValidation.ok, true);
      } finally {
        concurrentConnection.close();
      }

      const afterConcurrentChange = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(afterConcurrentChange.ok, false);
      assert.ok(
        afterConcurrentChange.errors.some(
          (error) => error.code === "ingest_run_persistence_mismatch",
        ),
      );
    });
  });

  it("detects rejected records assigned to the wrong ingest runs", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      const rejections = workspace.connection
        .prepare<{
          readonly id: number;
          readonly ingest_run_id: number;
          readonly source_kind: string;
        }>("SELECT id, ingest_run_id, source_kind FROM rejected_source_record ORDER BY id")
        .all();
      const spotify = rejections.find((rejection) => rejection.source_kind === "spotify");
      const lastfm = rejections.find((rejection) => rejection.source_kind === "lastfm");
      assert.notEqual(spotify, undefined);
      assert.notEqual(lastfm, undefined);

      workspace.connection
        .prepare("UPDATE rejected_source_record SET ingest_run_id = ? WHERE id = ?")
        .run([lastfm?.ingest_run_id ?? 0, spotify?.id ?? 0]);
      workspace.connection
        .prepare("UPDATE rejected_source_record SET ingest_run_id = ? WHERE id = ?")
        .run([spotify?.ingest_run_id ?? 0, lastfm?.id ?? 0]);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      assert.ok(validation.errors.some((error) => error.code === "rejection_ownership_invalid"));
    });
  });

  it("detects missing, non-regular, and escaped registered evidence paths", () => {
    withTemporaryTestWorkspace((workspace) => {
      const { spotifyPath } = importValidSyntheticEvidence(workspace);
      unlinkSync(spotifyPath);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(validation.errors.some((error) => error.code === "source_file_missing"));
    });

    withTemporaryTestWorkspace((workspace) => {
      const { spotifyPath } = importValidSyntheticEvidence(workspace);
      unlinkSync(spotifyPath);
      mkdirSync(spotifyPath);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(validation.errors.some((error) => error.code === "source_file_not_regular"));
    });

    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare(
          "UPDATE source_file SET relative_path = '../escaped.json' WHERE source_type = 'spotify_export'",
        )
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(validation.errors.some((error) => error.code === "source_file_path_invalid"));
    });
  });

  it("detects Last.fm fingerprint and occurrence-link corruption", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare("UPDATE lastfm_scrobble_source SET source_fingerprint_sha256 = ?")
        .run(["0".repeat(64)]);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(validation.errors.some((error) => error.code === "lastfm_fingerprint_mismatch"));
    });

    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection.prepare("DELETE FROM lastfm_scrobble_occurrence").run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(validation.errors.some((error) => error.code === "lastfm_occurrence_invalid"));
    });

    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      const spotifySourceRecordId = workspace.connection
        .prepare<{ readonly source_record_id: number }>(
          "SELECT source_record_id FROM spotify_play_source",
        )
        .get()?.source_record_id;
      assert.notEqual(spotifySourceRecordId, undefined);
      const misplaced = {
        albumName: null,
        artistMusicbrainzId: null,
        artistName: "Synthetic Validation Artist",
        loved: null,
        recordingMusicbrainzId: null,
        releaseMusicbrainzId: null,
        scrobbledAtEpochMs: 1_800_000_002_000,
        trackName: "Misplaced Evidence",
      } as const;
      workspace.connection
        .prepare(
          `INSERT INTO lastfm_scrobble_source
            (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, album_name,
             track_name, artist_musicbrainz_id, release_musicbrainz_id,
             recording_musicbrainz_id, loved, source_fingerprint_sha256)
           VALUES (?, 'export', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run([
          spotifySourceRecordId ?? 0,
          misplaced.scrobbledAtEpochMs,
          misplaced.artistName,
          misplaced.albumName,
          misplaced.trackName,
          misplaced.artistMusicbrainzId,
          misplaced.releaseMusicbrainzId,
          misplaced.recordingMusicbrainzId,
          misplaced.loved,
          fingerprintLastfmScrobble(misplaced),
        ]);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(validation.errors.some((error) => error.code === "lastfm_occurrence_invalid"));
    });
  });

  it("allows an API occurrence to reuse export-backed Last.fm evidence", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      const evidence = workspace.connection
        .prepare<{
          readonly source_fingerprint_sha256: string;
          readonly source_record_id: number;
        }>("SELECT source_record_id, source_fingerprint_sha256 FROM lastfm_scrobble_source")
        .get();
      assert.notEqual(evidence, undefined);

      runIngestLifecycle(
        {
          commandType: SourceEvidenceIngestCommand.LastfmApi,
          connection: workspace.connection,
          now: () => 1_800_000_002_000,
          schemaVersion: "11",
        },
        (context) => {
          const occurrence = context.connection
            .prepare(
              `INSERT INTO source_record (source_kind, ingest_run_id, accepted_at_epoch_ms)
               VALUES ('lastfm', ?, ?)`,
            )
            .run([context.runId, 1_800_000_002_000]);
          context.connection
            .prepare(
              `INSERT INTO lastfm_scrobble_occurrence
                (source_record_id, lastfm_scrobble_source_record_id, source_origin)
               VALUES (?, ?, 'api')`,
            )
            .run([Number(occurrence.lastInsertRowid), evidence?.source_record_id ?? 0]);
          context.recordOutcome({
            kind: "duplicate",
            code: IngestIssueCode.DuplicateRecord,
            sourceFingerprintSha256: evidence?.source_fingerprint_sha256 ?? "",
          });
          context.connection
            .prepare(
              `INSERT INTO lastfm_api_sync_metadata
                (ingest_run_id, page_count, completed_track_count, ignored_now_playing_count)
               VALUES (?, 1, 1, 0)`,
            )
            .run([context.runId]);
        },
      );
      resolveSourceIdentities(workspace.connection, { now: () => 1_800_000_002_500 });
      createCanonicalEvents(workspace.connection);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, true);
      assert.equal(
        validation.errors.some((error) => error.code === "lastfm_occurrence_invalid"),
        false,
      );
    });
  });

  it("detects incomplete runs and failed runs that retain evidence", () => {
    withTemporaryTestWorkspace((workspace) => {
      workspace.connection
        .prepare(
          `INSERT INTO ingest_run
            (command_type, started_at_epoch_ms, status, schema_version)
           VALUES ('spotify_import', 1, 'running', '4')`,
        )
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(validation.errors.some((error) => error.code === "ingest_run_incomplete"));
    });

    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare(
          `UPDATE ingest_run
           SET status = 'failed', safe_error_summary = ?
           WHERE command_type = 'spotify_import'`,
        )
        .run([IngestIssueSummary[IngestIssueCode.IngestFailed]]);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(validation.errors.some((error) => error.code === "failed_ingest_has_evidence"));
      assert.ok(validation.errors.some((error) => error.code === "source_file_run_link_invalid"));
    });
  });

  it("detects invalid rejection codes and incomplete rejection provenance", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare(
          `UPDATE rejected_source_record
           SET source_file_id = NULL, source_ordinal = NULL, error_code = 'unapproved_code'
           WHERE source_kind = 'spotify'`,
        )
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      const codes = new Set(validation.errors.map((error) => error.code));
      assert.equal(codes.has("rejection_code_invalid"), true);
      assert.equal(codes.has("rejection_provenance_incomplete"), true);
      assert.equal(codes.has("rejection_ownership_invalid"), true);
    });
  });

  it("detects a stored duplicate count that disagrees with fingerprint groups", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare(
          `UPDATE ingest_run
           SET duplicated_count = 1
           WHERE command_type = 'spotify_import'`,
        )
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(
        validation.errors.some((error) => error.code === "ingest_run_persistence_mismatch"),
      );
    });
  });

  it("detects missing canonical provenance without exposing source content", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare(
          "DELETE FROM listening_event_source WHERE source_record_id = (SELECT min(id) FROM source_record)",
        )
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      assert.ok(
        validation.errors.some((error) => error.code === "canonical_interpretation_missing"),
      );
      assert.ok(validation.errors.some((error) => error.code === "canonical_event_without_source"));
      assert.equal(JSON.stringify(validation).includes(PRIVATE_SENTINEL), false);
    });
  });

  it("detects a strong identifier resolved to a different track", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      const artistId = Number(
        workspace.connection
          .prepare(
            "INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('artist', 1)",
          )
          .run().lastInsertRowid,
      );
      workspace.connection
        .prepare("INSERT INTO artist (id, preferred_name) VALUES (?, 'Other Artist')")
        .run([artistId]);
      const trackId = Number(
        workspace.connection
          .prepare(
            "INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('track', 1)",
          )
          .run().lastInsertRowid,
      );
      workspace.connection
        .prepare("INSERT INTO track (id, artist_id, preferred_title) VALUES (?, ?, 'Other Track')")
        .run([trackId, artistId]);
      workspace.connection
        .prepare(
          `UPDATE source_identity_resolution
              SET artist_id = ?, release_id = NULL, track_id = ?
            WHERE source_record_id = (SELECT min(id) FROM source_record)`,
        )
        .run([artistId, trackId]);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      assert.ok(
        validation.errors.some(
          (error) => error.code === "identity_strong_identifier_conflict_unresolved",
        ),
      );
      assert.equal(JSON.stringify(validation).includes(PRIVATE_SENTINEL), false);
    });
  });

  it("detects manual reconciliation decisions that do not match canonical lineage", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      const spotifySourceRecordId = workspace.connection
        .prepare<{ readonly id: number }>(
          "SELECT id FROM source_record WHERE source_kind = 'spotify'",
        )
        .get()?.id;
      const lastfmSourceRecordId = workspace.connection
        .prepare<{ readonly id: number }>(
          "SELECT id FROM source_record WHERE source_kind = 'lastfm'",
        )
        .get()?.id;
      const spotifyEventId = workspace.connection
        .prepare<{ readonly id: number }>(
          `SELECT link.listening_event_id AS id
             FROM listening_event_source AS link
             JOIN source_record AS source ON source.id = link.source_record_id
            WHERE source.source_kind = 'spotify'`,
        )
        .get()?.id;
      const lastfmEventId = workspace.connection
        .prepare<{ readonly id: number }>(
          `SELECT link.listening_event_id AS id
             FROM listening_event_source AS link
             JOIN source_record AS source ON source.id = link.source_record_id
            WHERE source.source_kind = 'lastfm'`,
        )
        .get()?.id;
      assert.notEqual(spotifySourceRecordId, undefined);
      assert.notEqual(lastfmSourceRecordId, undefined);
      assert.notEqual(spotifyEventId, undefined);
      assert.notEqual(lastfmEventId, undefined);

      const candidateId = Number(
        workspace.connection
          .prepare(
            `INSERT INTO reconciliation_candidate
              (spotify_source_record_id, lastfm_source_record_id, artist_score, track_score,
               start_delta_ms, ambiguity_score, total_confidence, rule_version, candidate_state,
               resolved_at_epoch_ms, resolution_rationale)
             VALUES (?, ?, 1, 1, 0, 1, 1, 'fixture-v1', 'manually_accepted', 1, 'fixture')`,
          )
          .run([spotifySourceRecordId ?? 0, lastfmSourceRecordId ?? 0]).lastInsertRowid,
      );
      workspace.connection
        .prepare(
          `INSERT INTO manual_decision_artifact
            (decision_key, artifact_version, decision_type, payload_json, imported_at_epoch_ms)
           VALUES ('fixture-manual-accept', 'manual-decisions-v1', 'accept', '{}', 1)`,
        )
        .run();
      workspace.connection
        .prepare(
          `INSERT INTO manual_reconciliation_decision
            (decision_key, reconciliation_candidate_id, decision, source_listening_event_id,
             target_listening_event_id, source_event_status)
           VALUES ('fixture-manual-accept', ?, 'accept', ?, ?, 'current')`,
        )
        .run([candidateId, lastfmEventId ?? 0, spotifyEventId ?? 0]);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      assert.ok(
        validation.errors.some(
          (error) => error.code === "manual_reconciliation_decision_lineage_invalid",
        ),
      );
      assert.equal(JSON.stringify(validation).includes(PRIVATE_SENTINEL), false);
    });
  });

  it("detects invalid identity-decision supersession", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      const artistId = workspace.connection
        .prepare<{ readonly artist_id: number }>(
          "SELECT artist_id FROM source_identity_resolution ORDER BY source_record_id LIMIT 1",
        )
        .get()?.artist_id;
      assert.notEqual(artistId, undefined);
      const otherArtistId = Number(
        workspace.connection
          .prepare(
            "INSERT INTO music_entity (entity_type, created_at_epoch_ms) VALUES ('artist', 1)",
          )
          .run().lastInsertRowid,
      );
      workspace.connection
        .prepare("INSERT INTO artist (id, preferred_name) VALUES (?, 'Other Artist')")
        .run([otherArtistId]);
      const mergeId = Number(
        workspace.connection
          .prepare(
            `INSERT INTO identity_decision
              (decision_type, subject_entity_id, object_entity_id, decided_at_epoch_ms,
               decision_version, rationale)
             VALUES ('merge', ?, ?, 1, 'fixture-v1', 'fixture')`,
          )
          .run([artistId ?? 0, otherArtistId]).lastInsertRowid,
      );
      workspace.connection
        .prepare(
          `INSERT INTO identity_decision
            (decision_type, subject_entity_id, alias_text, decided_at_epoch_ms, decision_version,
             rationale, supersedes_decision_id)
           VALUES ('alias', ?, 'Other Alias', 2, 'fixture-v1', 'fixture', ?)`,
        )
        .run([artistId ?? 0, mergeId]);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      assert.ok(
        validation.errors.some((error) => error.code === "identity_decision_lineage_invalid"),
      );
      assert.equal(JSON.stringify(validation).includes(PRIVATE_SENTINEL), false);
    });
  });

  it("detects an unresolved canonical event for a resolved source identity", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare(
          `UPDATE listening_event
              SET event_status = 'unresolved'
            WHERE id = (SELECT min(listening_event_id) FROM listening_event_source)`,
        )
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      assert.ok(
        validation.errors.some((error) => error.code === "canonical_unresolved_state_invalid"),
      );
      assert.equal(JSON.stringify(validation).includes(PRIVATE_SENTINEL), false);
    });
  });

  it("detects an identity entity whose subtype does not match", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare(
          `UPDATE music_entity
              SET entity_type = 'artist'
            WHERE id = (SELECT track_id FROM source_identity_resolution LIMIT 1)`,
        )
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      assert.ok(validation.errors.some((error) => error.code === "identity_graph_entity_invalid"));
      assert.equal(JSON.stringify(validation).includes(PRIVATE_SENTINEL), false);
    });
  });

  it("detects an automatic acceptance without its canonical merge", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      const spotifySourceRecordId = workspace.connection
        .prepare<{ readonly id: number }>(
          "SELECT id FROM source_record WHERE source_kind = 'spotify'",
        )
        .get()?.id;
      const lastfmSourceRecordId = workspace.connection
        .prepare<{ readonly id: number }>(
          "SELECT id FROM source_record WHERE source_kind = 'lastfm'",
        )
        .get()?.id;
      const spotifyEventId = workspace.connection
        .prepare<{ readonly id: number }>(
          `SELECT link.listening_event_id AS id
             FROM listening_event_source AS link
             JOIN source_record AS source ON source.id = link.source_record_id
            WHERE source.source_kind = 'spotify'`,
        )
        .get()?.id;
      const lastfmEventId = workspace.connection
        .prepare<{ readonly id: number }>(
          `SELECT link.listening_event_id AS id
             FROM listening_event_source AS link
             JOIN source_record AS source ON source.id = link.source_record_id
            WHERE source.source_kind = 'lastfm'`,
        )
        .get()?.id;
      assert.notEqual(spotifySourceRecordId, undefined);
      assert.notEqual(lastfmSourceRecordId, undefined);
      assert.notEqual(spotifyEventId, undefined);
      assert.notEqual(lastfmEventId, undefined);
      const candidateId = Number(
        workspace.connection
          .prepare(
            `INSERT INTO reconciliation_candidate
              (spotify_source_record_id, lastfm_source_record_id, artist_score, track_score,
               start_delta_ms, ambiguity_score, total_confidence, rule_version, candidate_state,
               resolved_at_epoch_ms, resolution_rationale)
             VALUES (?, ?, 1, 1, 0, 1, 1, 'fixture-v1', 'auto_accepted', 1, 'fixture')`,
          )
          .run([spotifySourceRecordId ?? 0, lastfmSourceRecordId ?? 0]).lastInsertRowid,
      );
      workspace.connection
        .prepare(
          `INSERT INTO reconciliation_decision
            (reconciliation_candidate_id, policy_rule_version, decision, applied_at_epoch_ms,
             decision_state, source_listening_event_id, target_listening_event_id,
             source_event_status, rationale)
           VALUES (?, 'fixture-policy-v1', 'auto_accept', 1, 'active', ?, ?, 'current', 'fixture')`,
        )
        .run([candidateId, lastfmEventId ?? 0, spotifyEventId ?? 0]);

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      assert.ok(
        validation.errors.some((error) => error.code === "reconciliation_decision_lineage_invalid"),
      );
      assert.equal(JSON.stringify(validation).includes(PRIVATE_SENTINEL), false);
    });
  });

  it("detects empty reconciliation rule versions", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare("UPDATE listening_event SET reconciliation_rule_version = ' '")
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.equal(validation.ok, false);
      assert.ok(
        validation.errors.some((error) => error.code === "reconciliation_rule_version_invalid"),
      );
      assert.equal(JSON.stringify(validation).includes(PRIVATE_SENTINEL), false);
    });
  });

  it("detects persisted ordinal ranges and gaps that disagree with run totals", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection
        .prepare(
          `UPDATE source_record
           SET source_ordinal = 4
           WHERE source_kind = 'spotify'`,
        )
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(validation.errors.some((error) => error.code === "record_ordinal_range_mismatch"));
    });

    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      workspace.connection.execute("DROP TRIGGER ingest_run_reconcile_counts_before_update");
      workspace.connection
        .prepare(
          `UPDATE ingest_run
           SET excluded_count = 1
           WHERE command_type = 'spotify_import'`,
        )
        .run();
      workspace.connection
        .prepare(
          `UPDATE rejected_source_record
           SET source_ordinal = 3
           WHERE source_kind = 'spotify'`,
        )
        .run();

      const validation = validateEvidenceLayer(
        workspace.connection,
        workspace.configuration.paths.inputsDirectory,
      );
      assert.ok(validation.errors.some((error) => error.code === "record_ordinal_gap_mismatch"));
    });
  });

  it("fails safely for seeded totals, ordinal, fingerprint, rejection, and foreign-key inconsistencies", () => {
    withTemporaryTestWorkspace((workspace) => {
      importValidSyntheticEvidence(workspace);
      const spotifyRunId = workspace.connection
        .prepare<{ readonly id: number }>(
          "SELECT id FROM ingest_run WHERE command_type = 'spotify_import'",
        )
        .get()?.id;
      assert.notEqual(spotifyRunId, undefined);

      workspace.connection
        .prepare(
          `UPDATE ingest_run
           SET accepted_count = accepted_count - 1,
               excluded_count = excluded_count + 1
           WHERE id = ?`,
        )
        .run([spotifyRunId ?? 0]);
      workspace.connection
        .prepare("UPDATE spotify_play_source SET source_fingerprint_sha256 = ?")
        .run(["0".repeat(64)]);
      workspace.connection
        .prepare(
          `UPDATE rejected_source_record
           SET source_ordinal = 0, safe_diagnostic_summary = ?
           WHERE source_kind = 'spotify'`,
        )
        .run([PRIVATE_SENTINEL]);
      workspace.connection.execute("PRAGMA foreign_keys = OFF");
      workspace.connection
        .prepare(
          "UPDATE source_file SET last_ingest_run_id = 999999 WHERE source_type = 'lastfm_export'",
        )
        .run();
      workspace.connection.execute("PRAGMA foreign_keys = ON");

      const command = runValidationCommand({
        connection: workspace.connection,
        evidenceRoot: workspace.configuration.paths.inputsDirectory,
      });
      assert.equal(command.status, "error");
      assert.equal(command.exitCode, 4);
      const codes = new Set(command.errors?.map((error) => error.code));
      assert.equal(codes.has("ingest_run_persistence_mismatch"), true);
      assert.equal(codes.has("record_ordinal_conflict"), true);
      assert.equal(codes.has("spotify_fingerprint_mismatch"), true);
      assert.equal(codes.has("rejection_summary_unsafe"), true);
      assert.equal(codes.has("database_integrity_failed"), true);
      assert.equal(JSON.stringify(command).includes(PRIVATE_SENTINEL), false);
      assert.equal(JSON.stringify(command).includes("Clockwork Garden"), false);
    });
  });
});
