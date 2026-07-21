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
  it("returns aggregate dry-run metadata without modifying an empty synthetic database", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, ["--json", "--dry-run"]);

      assert.equal(completed.status, 0, completed.stderr);
      const result = JSON.parse(completed.stdout) as {
        readonly data: {
          readonly autoAccepted: number;
          readonly dryRun: boolean;
          readonly policyRuleVersion: string;
        };
      };
      assert.deepEqual(result.data, {
        autoAccepted: 0,
        dryRun: true,
        ignored: 0,
        policyRuleVersion: "cross-source-decision-policy-v1",
        review: 0,
        skipped: 0,
        supersededAutomaticDecisions: 0,
      });
      assert.equal(
        workspace.connection.prepare("SELECT count(*) AS count FROM reconciliation_decision").get()
          ?.count,
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
