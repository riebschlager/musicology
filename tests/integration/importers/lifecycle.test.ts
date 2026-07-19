import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SqliteRow } from "../../../src/db/connection.ts";
import {
  HistoricalIngestCommand,
  IngestIssueCode,
  IngestIssueSummary,
  SupportedSourceType,
  type HashedSourceFile,
  type IngestSummary,
} from "../../../src/importers/contracts.ts";
import { IngestLifecycleError, runIngestLifecycle } from "../../../src/importers/lifecycle.ts";
import { withTemporaryTestWorkspace } from "../../helpers/temporary-workspace.ts";

const FINGERPRINT = "b".repeat(64);

interface CountRow extends SqliteRow {
  readonly count: number;
}

interface RunRow extends SqliteRow {
  readonly accepted_count: number;
  readonly completed_at_epoch_ms: number | null;
  readonly discovered_count: number;
  readonly discovered_file_count: number;
  readonly duplicated_count: number;
  readonly excluded_count: number;
  readonly noop_file_count: number;
  readonly registered_file_count: number;
  readonly rejected_count: number;
  readonly safe_error_summary: string | null;
  readonly status: string;
  readonly unsupported_count: number;
}

interface RejectionRow extends SqliteRow {
  readonly error_code: string;
  readonly safe_diagnostic_summary: string;
}

interface SourceFileRow extends SqliteRow {
  readonly content_sha256: string;
  readonly first_ingest_run_id: number;
  readonly last_ingest_run_id: number;
  readonly relative_path: string;
}

function sourceFile(
  relativePath = "spotify/synthetic.json",
  contentSha256 = "a".repeat(64),
): HashedSourceFile {
  return {
    absolutePath: `/synthetic/${relativePath}`,
    relativePath,
    sourceType: SupportedSourceType.SpotifyExport,
    byteSize: 128,
    contentSha256,
  };
}

function assertReconciles(summary: IngestSummary): void {
  assert.equal(
    summary.records.discovered,
    summary.records.accepted + summary.records.excluded + summary.records.rejected,
  );
  assert.ok(summary.records.duplicated <= summary.records.accepted);
  assert.equal(
    summary.files.discovered,
    summary.files.registered + summary.files.noOp + summary.files.unsupported,
  );
}

describe("transactional ingest lifecycle", () => {
  it("commits a successful run, file registration, evidence, and reconciled summary", () => {
    withTemporaryTestWorkspace(({ connection }) => {
      let clock = 1_000;
      const summary = runIngestLifecycle(
        {
          commandType: HistoricalIngestCommand.Spotify,
          connection,
          now: () => clock++,
          schemaVersion: "2",
        },
        (context) => {
          const registration = context.registerSourceFile(sourceFile());
          context.connection
            .prepare(
              `INSERT INTO source_record
                (source_kind, ingest_run_id, source_file_id, source_ordinal, accepted_at_epoch_ms)
               VALUES ('spotify', @runId, @sourceFileId, 0, 1000)`,
            )
            .run({ runId: context.runId, sourceFileId: registration.sourceFileId });
          context.recordOutcome({ kind: "accepted", sourceFingerprintSha256: FINGERPRINT });
          context.recordOutcome({
            kind: "duplicate",
            code: IngestIssueCode.DuplicateRecord,
            sourceFingerprintSha256: FINGERPRINT,
          });
          context.recordOutcome({
            kind: "excluded",
            code: IngestIssueCode.ExcludedNonMusicRecord,
          });
          context.recordUnsupportedFile();
        },
      );

      assert.deepEqual(summary.files, {
        discovered: 2,
        registered: 1,
        noOp: 0,
        unsupported: 1,
      });
      assert.deepEqual(summary.records, {
        discovered: 3,
        accepted: 2,
        duplicated: 1,
        excluded: 1,
        rejected: 0,
      });
      assert.equal(summary.noOp, false);
      assertReconciles(summary);

      const run = connection
        .prepare<RunRow>(
          `SELECT status, safe_error_summary, discovered_file_count, registered_file_count,
                  noop_file_count, discovered_count, accepted_count, duplicated_count,
                  excluded_count, rejected_count, unsupported_count
           FROM ingest_run
           WHERE id = ?`,
        )
        .get([summary.runId]);
      assert.deepEqual(run, {
        status: "succeeded",
        safe_error_summary: null,
        discovered_file_count: 2,
        registered_file_count: 1,
        noop_file_count: 0,
        discovered_count: 3,
        accepted_count: 2,
        duplicated_count: 1,
        excluded_count: 1,
        rejected_count: 0,
        unsupported_count: 1,
      });
    });
  });

  it("reports an unchanged registered file as a no-op", () => {
    withTemporaryTestWorkspace(({ connection }) => {
      const options = {
        commandType: HistoricalIngestCommand.Spotify,
        connection,
        now: () => 2_000,
        schemaVersion: "2",
      } as const;
      runIngestLifecycle(options, (context) => {
        context.registerSourceFile(sourceFile());
      });

      const summary = runIngestLifecycle(options, (context) => {
        const registration = context.registerSourceFile(sourceFile());
        assert.equal(registration.status, "already_registered");
      });

      assert.equal(summary.noOp, true);
      assert.deepEqual(summary.files, {
        discovered: 1,
        registered: 0,
        noOp: 1,
        unsupported: 0,
      });
      assert.deepEqual(summary.records, {
        discovered: 0,
        accepted: 0,
        duplicated: 0,
        excluded: 0,
        rejected: 0,
      });
      assert.equal(
        connection.prepare<CountRow>("SELECT count(*) AS count FROM source_file").get()?.count,
        1,
      );
      assertReconciles(summary);
    });
  });

  it("recognizes byte-identical content under a renamed path by content hash", () => {
    withTemporaryTestWorkspace(({ connection }) => {
      const options = {
        commandType: HistoricalIngestCommand.Spotify,
        connection,
        now: () => 2_500,
        schemaVersion: "2",
      } as const;
      runIngestLifecycle(options, (context) => {
        context.registerSourceFile(sourceFile());
      });

      const renamed = runIngestLifecycle(options, (context) => {
        assert.deepEqual(context.registerSourceFile(sourceFile("spotify/renamed.json")), {
          status: "already_registered",
          matchedBy: "content_hash",
          sourceFileId: 1,
        });
      });

      assert.equal(renamed.noOp, true);
      assert.deepEqual(renamed.files, {
        discovered: 1,
        registered: 0,
        noOp: 1,
        unsupported: 0,
      });
      assert.equal(
        connection.prepare<CountRow>("SELECT count(*) AS count FROM source_file").get()?.count,
        1,
      );
      assertReconciles(renamed);
    });
  });

  it("rejects noncanonical evidence paths before registration", () => {
    for (const relativePath of [
      "./spotify/synthetic.json",
      "spotify/./synthetic.json",
      "spotify//synthetic.json",
      "spotify\\synthetic.json",
      "C:/spotify/synthetic.json",
      "spotify/synthetic.json/",
    ]) {
      withTemporaryTestWorkspace(({ connection }) => {
        assert.throws(
          () =>
            runIngestLifecycle(
              {
                commandType: HistoricalIngestCommand.Spotify,
                connection,
                now: () => 2_750,
                schemaVersion: "2",
              },
              (context) => {
                context.registerSourceFile(sourceFile(relativePath));
              },
            ),
          (error: unknown) =>
            error instanceof IngestLifecycleError && error.code === IngestIssueCode.UnsupportedFile,
        );
        assert.equal(
          connection.prepare<CountRow>("SELECT count(*) AS count FROM source_file").get()?.count,
          0,
        );
      });
    }
  });

  it("rejects changed content at a registered path without modifying evidence", () => {
    withTemporaryTestWorkspace(({ connection }) => {
      const options = {
        commandType: HistoricalIngestCommand.Spotify,
        connection,
        now: () => 2_900,
        schemaVersion: "2",
      } as const;
      runIngestLifecycle(options, (context) => {
        context.registerSourceFile(sourceFile());
      });

      assert.throws(
        () =>
          runIngestLifecycle(options, (context) => {
            context.registerSourceFile(sourceFile("spotify/synthetic.json", "d".repeat(64)));
          }),
        (error: unknown) =>
          error instanceof IngestLifecycleError && error.code === IngestIssueCode.SourceFileChanged,
      );

      const persisted = connection
        .prepare<SourceFileRow>(
          `SELECT relative_path, content_sha256, first_ingest_run_id, last_ingest_run_id
           FROM source_file`,
        )
        .get();
      assert.deepEqual(persisted, {
        relative_path: "spotify/synthetic.json",
        content_sha256: "a".repeat(64),
        first_ingest_run_id: 1,
        last_ingest_run_id: 1,
      });
    });
  });

  it("commits accepted evidence and a fixed safe diagnostic for a partially rejected run", () => {
    withTemporaryTestWorkspace(({ connection }) => {
      const privateValue = "synthetic-private-source-value";
      const summary = runIngestLifecycle(
        {
          commandType: HistoricalIngestCommand.LastfmExport,
          connection,
          now: () => 3_000,
          schemaVersion: "2",
        },
        (context) => {
          const registration = context.registerSourceFile({
            ...sourceFile("lastfm/synthetic.json", "c".repeat(64)),
            sourceType: SupportedSourceType.LastfmExport,
          });
          context.connection
            .prepare(
              `INSERT INTO rejected_source_record
                (ingest_run_id, source_file_id, source_ordinal, source_kind, error_code,
                 safe_diagnostic_summary, rejected_at_epoch_ms)
               VALUES
                (@runId, @sourceFileId, 1, 'lastfm', @errorCode,
                 @safeDiagnosticSummary, 3000)`,
            )
            .run({
              errorCode: IngestIssueCode.RejectedRecord,
              runId: context.runId,
              safeDiagnosticSummary: IngestIssueSummary[IngestIssueCode.RejectedRecord],
              sourceFileId: registration.sourceFileId,
            });
          context.recordOutcome({ kind: "accepted", sourceFingerprintSha256: FINGERPRINT });
          context.recordOutcome({
            kind: "rejected",
            code: IngestIssueCode.RejectedRecord,
          });

          // Source-specific validation may encounter private values, but the shared outcome and
          // persisted diagnostic expose only the fixed issue code and privacy-reviewed summary.
          assert.equal(
            IngestIssueSummary[IngestIssueCode.RejectedRecord].includes(privateValue),
            false,
          );
        },
      );

      assert.deepEqual(summary.records, {
        discovered: 2,
        accepted: 1,
        duplicated: 0,
        excluded: 0,
        rejected: 1,
      });
      const rejection = connection
        .prepare<RejectionRow>(
          "SELECT error_code, safe_diagnostic_summary FROM rejected_source_record",
        )
        .get();
      assert.deepEqual(rejection, {
        error_code: IngestIssueCode.RejectedRecord,
        safe_diagnostic_summary: IngestIssueSummary[IngestIssueCode.RejectedRecord],
      });
      assert.equal(rejection?.safe_diagnostic_summary.includes(privateValue), false);
      assertReconciles(summary);
    });
  });

  it("rolls back files and partial evidence while retaining only a failed audit run", () => {
    withTemporaryTestWorkspace(({ connection }) => {
      assert.throws(
        () =>
          runIngestLifecycle(
            {
              commandType: HistoricalIngestCommand.Spotify,
              connection,
              now: () => 4_000,
              schemaVersion: "2",
            },
            (context) => {
              const registration = context.registerSourceFile(sourceFile());
              context.connection
                .prepare(
                  `INSERT INTO source_record
                    (source_kind, ingest_run_id, source_file_id, source_ordinal,
                     accepted_at_epoch_ms)
                   VALUES ('spotify', @runId, @sourceFileId, 0, 4000)`,
                )
                .run({ runId: context.runId, sourceFileId: registration.sourceFileId });
              context.recordOutcome({ kind: "accepted", sourceFingerprintSha256: FINGERPRINT });
              throw new IngestLifecycleError(IngestIssueCode.MalformedFile);
            },
          ),
        (error: unknown) =>
          error instanceof IngestLifecycleError &&
          error.code === IngestIssueCode.MalformedFile &&
          error.runId === 1,
      );

      for (const table of ["source_file", "source_record", "rejected_source_record"] as const) {
        assert.equal(
          connection.prepare<CountRow>(`SELECT count(*) AS count FROM ${table}`).get()?.count,
          0,
        );
      }
      const run = connection.prepare<RunRow>("SELECT * FROM ingest_run WHERE id = 1").get();
      assert.equal(run?.status, "failed");
      assert.equal(run?.safe_error_summary, "Source file is malformed");
      assert.equal(run?.accepted_count, 0);
      assert.equal(run?.discovered_count, 0);
      assert.equal(run?.registered_file_count, 0);
    });
  });

  it("does not persist an unexpected error message that could contain source data", () => {
    withTemporaryTestWorkspace(({ connection }) => {
      const privateValue = "synthetic-private-value";
      assert.throws(
        () =>
          runIngestLifecycle(
            {
              commandType: HistoricalIngestCommand.LastfmExport,
              connection,
              now: () => 5_000,
              schemaVersion: "2",
            },
            () => {
              throw new Error(`Parser exposed ${privateValue}`);
            },
          ),
        (error: unknown) => {
          assert.ok(error instanceof IngestLifecycleError);
          assert.equal(error.code, IngestIssueCode.IngestFailed);
          assert.equal(error.message.includes(privateValue), false);
          assert.equal(error.cause, undefined);
          return true;
        },
      );

      const run = connection.prepare<RunRow>("SELECT * FROM ingest_run WHERE id = 1").get();
      assert.equal(run?.safe_error_summary, "Import failed; no source evidence was committed");
      assert.equal(run?.safe_error_summary?.includes(privateValue), false);
    });
  });

  it("retains a failed audit row when the completion clock throws", () => {
    withTemporaryTestWorkspace(({ connection }) => {
      let clockReads = 0;
      const privateValue = "synthetic-private-clock-value";

      assert.throws(
        () =>
          runIngestLifecycle(
            {
              commandType: HistoricalIngestCommand.Spotify,
              connection,
              now: () => {
                clockReads += 1;
                if (clockReads === 1) {
                  return 6_000;
                }
                throw new Error(`Clock exposed ${privateValue}`);
              },
              schemaVersion: "2",
            },
            (context) => {
              context.registerSourceFile(sourceFile());
            },
          ),
        (error: unknown) => {
          assert.ok(error instanceof IngestLifecycleError);
          assert.equal(error.code, IngestIssueCode.IngestFailed);
          assert.equal(error.message.includes(privateValue), false);
          return true;
        },
      );

      const run = connection.prepare<RunRow>("SELECT * FROM ingest_run WHERE id = 1").get();
      assert.equal(run?.status, "failed");
      assert.equal(run?.completed_at_epoch_ms, 6_000);
      assert.equal(run?.safe_error_summary, IngestIssueSummary[IngestIssueCode.IngestFailed]);
      assert.equal(run?.safe_error_summary?.includes(privateValue), false);
      assert.equal(
        connection.prepare<CountRow>("SELECT count(*) AS count FROM source_file").get()?.count,
        0,
      );
    });
  });

  it("retains a failed audit row when the completion clock returns an invalid epoch", () => {
    withTemporaryTestWorkspace(({ connection }) => {
      let clockReads = 0;

      assert.throws(
        () =>
          runIngestLifecycle(
            {
              commandType: HistoricalIngestCommand.LastfmExport,
              connection,
              now: () => {
                clockReads += 1;
                return clockReads === 1 ? 7_000 : -1;
              },
              schemaVersion: "2",
            },
            () => undefined,
          ),
        (error: unknown) =>
          error instanceof IngestLifecycleError && error.code === IngestIssueCode.IngestFailed,
      );

      const run = connection.prepare<RunRow>("SELECT * FROM ingest_run WHERE id = 1").get();
      assert.equal(run?.status, "failed");
      assert.equal(run?.completed_at_epoch_ms, 7_000);
      assert.equal(run?.safe_error_summary, IngestIssueSummary[IngestIssueCode.IngestFailed]);
    });
  });
});
