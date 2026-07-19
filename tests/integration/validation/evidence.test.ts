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
import { IngestIssueCode, IngestIssueSummary } from "../../../src/importers/contracts.ts";
import { importLastfmExportFiles } from "../../../src/importers/lastfm-export/persistence.ts";
import { importSpotifyFiles } from "../../../src/importers/spotify/persistence.ts";
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
  return { lastfmPath, spotifyPath };
}

describe("evidence-layer validation", () => {
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
