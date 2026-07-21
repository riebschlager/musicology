import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";

import { repositoryRoot } from "../../../src/config/config.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

function runCli(workspace: TemporaryTestWorkspace, args: readonly string[]) {
  return spawnSync(process.execPath, [path.join(repositoryRoot, "src/cli/reconcile.ts"), ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MUSICOLOGY_DATABASE_PATH: workspace.configuration.paths.databasePath,
    },
  });
}

describe("reconcile CLI", () => {
  it("materializes unrepresented evidence and repeats as a no-op", () => {
    withTemporaryTestWorkspace((workspace) => {
      workspace.connection
        .prepare(
          `INSERT INTO ingest_run
            (id, command_type, started_at_epoch_ms, status, schema_version)
           VALUES (1, 'identity_resolution', 1, 'running', '10')`,
        )
        .run();
      workspace.connection
        .prepare(
          `INSERT INTO source_record
            (id, source_kind, ingest_run_id, accepted_at_epoch_ms)
           VALUES (1, 'spotify', 1, 1)`,
        )
        .run();
      workspace.connection
        .prepare(
          `INSERT INTO spotify_play_source
            (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri, artist_name,
             track_name, shuffle, source_fingerprint_sha256)
           VALUES (1, 10000, 1000, 'spotify:track:reconcile-cli', 'Synthetic Artist',
                   'Synthetic Track', 0, '${"a".repeat(64)}')`,
        )
        .run();

      const completed = runCli(workspace, ["--json"]);
      assert.equal(completed.status, 0, completed.stderr);
      const result = JSON.parse(completed.stdout) as {
        readonly data: { readonly pipeline: { readonly canonicalEvents: number } };
      };
      assert.equal(result.data.pipeline.canonicalEvents, 1);
      assert.equal(
        workspace.connection
          .prepare("SELECT count(*) AS count FROM source_identity_resolution")
          .get()?.count,
        1,
      );
      assert.equal(
        workspace.connection.prepare("SELECT count(*) AS count FROM listening_event_source").get()
          ?.count,
        1,
      );

      const repeated = runCli(workspace, ["--json"]);
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.equal(
        (
          JSON.parse(repeated.stdout) as {
            readonly data: { readonly pipeline: { readonly canonicalEvents: number } };
          }
        ).data.pipeline.canonicalEvents,
        0,
      );
    });
  });

  it("returns aggregate dry-run metadata without modifying an empty synthetic database", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, ["--json", "--dry-run"]);

      assert.equal(completed.status, 0, completed.stderr);
      const result = JSON.parse(completed.stdout) as {
        readonly data: {
          readonly autoAccepted: number;
          readonly dryRun: boolean;
          readonly pipeline: {
            readonly candidatePairs: number;
            readonly canonicalEvents: number;
            readonly exactDuplicatesCollapsed: number;
            readonly identitiesResolved: number;
            readonly matchFeatures: number;
          };
          readonly policyRuleVersion: string;
        };
      };
      assert.deepEqual(result.data, {
        autoAccepted: 0,
        dryRun: true,
        ignored: 0,
        policyRuleVersion: "cross-source-decision-policy-v1",
        pipeline: {
          candidatePairs: 0,
          canonicalEvents: 0,
          exactDuplicatesCollapsed: 0,
          identitiesResolved: 0,
          matchFeatures: 0,
        },
        review: 0,
        skipped: 0,
        supersededAutomaticDecisions: 0,
      });
      assert.equal(
        workspace.connection.prepare("SELECT count(*) AS count FROM reconciliation_decision").get()
          ?.count,
        0,
      );
      assert.equal(
        workspace.connection
          .prepare("SELECT count(*) AS count FROM source_identity_resolution")
          .get()?.count,
        0,
      );
    });
  });

  it("rejects unknown policy versions safely", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, ["--json", "--rule-version", "unavailable"]);

      assert.equal(completed.status, 2);
      const result = JSON.parse(completed.stderr) as {
        readonly errors: readonly { readonly code: string }[];
      };
      assert.equal(result.errors[0]?.code, "invalid_arguments");
    });
  });
});
