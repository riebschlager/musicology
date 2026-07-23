import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { repositoryRoot } from "../../../src/config/config.ts";
import {
  withTemporaryTestWorkspace,
  type TemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

function runCli(workspace: TemporaryTestWorkspace, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "src/cli/export-analytics.ts"), ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MUSICOLOGY_DATABASE_PATH: workspace.configuration.paths.databasePath,
        MUSICOLOGY_OUTPUTS_DIR: workspace.configuration.paths.outputsDirectory,
        MUSICOLOGY_TIMEZONE: "America/Chicago",
      },
    },
  );
}

describe("export:analytics CLI", () => {
  it("writes and verifies the analytical export bundle", () => {
    withTemporaryTestWorkspace((workspace) => {
      const exported = runCli(workspace, ["--json"]);
      assert.equal(exported.status, 0, exported.stderr);
      const body = JSON.parse(exported.stdout) as {
        readonly data: { readonly schemaVersion: string };
      };
      assert.equal(body.data.schemaVersion, "analytical-export-v1");
      assert.equal(
        existsSync(
          path.join(
            workspace.configuration.paths.outputsDirectory,
            "analytics-v1",
            "manifest.json",
          ),
        ),
        true,
      );
      const checked = runCli(workspace, ["--json", "--check"]);
      assert.equal(checked.status, 0, checked.stderr);
    });
  });
});
