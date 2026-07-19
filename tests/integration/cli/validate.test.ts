import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { repositoryRoot } from "../../../src/config/config.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

function runCli(
  workspace: TemporaryTestWorkspace,
  args: readonly string[],
  databasePath = workspace.configuration.paths.databasePath,
) {
  return spawnSync(process.execPath, [path.join(repositoryRoot, "src/cli/validate.ts"), ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MUSICOLOGY_DATABASE_PATH: databasePath,
      MUSICOLOGY_INPUTS_DIR: workspace.configuration.paths.inputsDirectory,
    },
  });
}

describe("validate CLI", () => {
  it("returns structured invariant status and non-fatal baseline findings", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, ["--json"]);

      assert.equal(completed.status, 0, completed.stderr);
      assert.equal(completed.stderr, "");
      const result = JSON.parse(completed.stdout) as {
        readonly command: string;
        readonly data: {
          readonly findings: readonly { readonly code: string }[];
          readonly integrity: { readonly ok: boolean };
          readonly ok: boolean;
        };
        readonly exitCode: number;
        readonly status: string;
      };
      assert.equal(result.command, "validate");
      assert.equal(result.status, "success");
      assert.equal(result.exitCode, 0);
      assert.equal(result.data.ok, true);
      assert.equal(result.data.integrity.ok, true);
      assert.ok(result.data.findings.length > 0);
      assert.ok(
        result.data.findings.every((finding) => finding.code === "archive_baseline_deviation"),
      );
    });
  });

  it("rejects positional arguments without inspecting source evidence", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, ["--json", "unexpected"]);

      assert.equal(completed.status, 2);
      assert.equal(completed.stdout, "");
      const result = JSON.parse(completed.stderr) as {
        readonly errors: readonly { readonly code: string }[];
      };
      assert.equal(result.errors[0]?.code, "invalid_arguments");
    });
  });

  it("rejects a missing database without creating it or its parent directory", () => {
    withTemporaryTestWorkspace((workspace) => {
      const missingParent = path.join(workspace.rootPath, "missing-database-parent");
      const missingDatabase = path.join(missingParent, "musicology.sqlite3");

      const completed = runCli(workspace, ["--json"], missingDatabase);

      assert.equal(completed.status, 4);
      assert.equal(completed.stdout, "");
      const result = JSON.parse(completed.stderr) as {
        readonly errors: readonly { readonly code: string }[];
      };
      assert.equal(result.errors[0]?.code, "database_not_ready");
      assert.equal(existsSync(missingDatabase), false);
      assert.equal(existsSync(missingParent), false);
    });
  });
});
