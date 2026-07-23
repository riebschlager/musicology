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
  return spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "src/cli/analyze-abandonment.ts"), ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MUSICOLOGY_DATABASE_PATH: workspace.configuration.paths.databasePath,
        MUSICOLOGY_TIMEZONE: "America/Chicago",
      },
    },
  );
}

describe("analyze:abandonment CLI", () => {
  it("emits the versioned result envelope and concise human result", () => {
    withTemporaryTestWorkspace((workspace) => {
      const json = runCli(workspace, ["--json", "--dormancy-days", "90"]);
      assert.equal(json.status, 0, json.stderr);
      assert.equal(
        (
          JSON.parse(json.stdout) as {
            readonly command: string;
            readonly data: { readonly analysis: string };
          }
        ).command,
        "analyze:abandonment",
      );
      assert.equal(
        (JSON.parse(json.stdout) as { readonly data: { readonly analysis: string } }).data.analysis,
        "abandonment",
      );
      const human = runCli(workspace, []);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /Abandonment analysis/u);
    });
  });

  it("rejects invalid arguments with a safe usage result", () => {
    withTemporaryTestWorkspace((workspace) => {
      const result = runCli(workspace, ["--json", "--as-of", "not-a-date"]);
      assert.equal(result.status, 2);
      assert.equal(
        (JSON.parse(result.stderr) as { readonly errors: readonly { readonly code: string }[] })
          .errors[0]?.code,
        "invalid_arguments",
      );
    });
  });
});
