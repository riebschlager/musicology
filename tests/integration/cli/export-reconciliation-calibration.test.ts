import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { repositoryRoot } from "../../../src/config/config.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

function runCli(workspace: TemporaryTestWorkspace, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "src/cli/export-reconciliation-calibration.ts"), ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MUSICOLOGY_DATABASE_PATH: workspace.configuration.paths.databasePath,
        MUSICOLOGY_OUTPUTS_DIR: workspace.configuration.paths.outputsDirectory,
      },
    },
  );
}

describe("export:reconciliation-calibration CLI", () => {
  it("writes a fixed privacy-safe sample artifact and returns only aggregate metadata", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, ["--json", "--per-stratum", "1"]);

      assert.equal(completed.status, 0, completed.stderr);
      assert.equal(completed.stderr, "");
      const result = JSON.parse(completed.stdout) as {
        readonly data: { readonly candidateCount: number; readonly outputFilename: string };
      };
      assert.equal(result.data.candidateCount, 0);
      assert.equal(result.data.outputFilename, "reconciliation-calibration-sample.json");
      const artifactPath = path.join(
        workspace.configuration.paths.outputsDirectory,
        result.data.outputFilename,
      );
      assert.equal(existsSync(artifactPath), true);
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
        readonly candidates: readonly unknown[];
        readonly sampleVersion: string;
      };
      assert.deepEqual(artifact.candidates, []);
      assert.equal(artifact.sampleVersion, "cross-source-calibration-sample-v1");
    });
  });

  it("rejects invalid sampling bounds without creating an artifact", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, ["--json", "--per-stratum", "0"]);

      assert.equal(completed.status, 2);
      const result = JSON.parse(completed.stderr) as {
        readonly errors: readonly { readonly code: string }[];
      };
      assert.equal(result.errors[0]?.code, "invalid_arguments");
      assert.equal(
        existsSync(
          path.join(
            workspace.configuration.paths.outputsDirectory,
            "reconciliation-calibration-sample.json",
          ),
        ),
        false,
      );
    });
  });

  it("does not overwrite a locally labeled calibration artifact", () => {
    withTemporaryTestWorkspace((workspace) => {
      const first = runCli(workspace, ["--json"]);
      assert.equal(first.status, 0, first.stderr);
      const artifactPath = path.join(
        workspace.configuration.paths.outputsDirectory,
        "reconciliation-calibration-sample.json",
      );
      const before = readFileSync(artifactPath, "utf8");

      const second = runCli(workspace, ["--json"]);

      assert.equal(second.status, 4);
      const result = JSON.parse(second.stderr) as {
        readonly errors: readonly { readonly code: string }[];
      };
      assert.equal(result.errors[0]?.code, "calibration_output_exists");
      assert.equal(readFileSync(artifactPath, "utf8"), before);
    });
  });
});
