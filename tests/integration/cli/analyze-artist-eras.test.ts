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
    [path.join(repositoryRoot, "src/cli/analyze-artist-eras.ts"), ...args],
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

describe("analyze:artist-eras CLI", () => {
  it("emits the versioned result envelope as JSON and concise human output", () => {
    withTemporaryTestWorkspace((workspace) => {
      const json = runCli(workspace, ["--json"]);
      assert.equal(json.status, 0, json.stderr);
      const result = JSON.parse(json.stdout) as {
        readonly command: string;
        readonly data: {
          readonly analysis: string;
          readonly result: { readonly intervals: unknown[] };
        };
      };
      assert.equal(result.command, "analyze:artist-eras");
      assert.equal(result.data.analysis, "artist-eras");
      assert.deepEqual(result.data.result.intervals, []);
      const human = runCli(workspace, []);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /Artist eras/u);
      assert.equal(human.stdout.includes('"schemaVersion"'), false);
    });
  });

  it("rejects invalid arguments with a safe usage result", () => {
    withTemporaryTestWorkspace((workspace) => {
      const result = runCli(workspace, ["--json", "--window-size-months", "0"]);
      assert.equal(result.status, 2);
      const body = JSON.parse(result.stderr) as {
        readonly errors: readonly { readonly code: string }[];
      };
      assert.equal(body.errors[0]?.code, "invalid_arguments");
    });
  });
});
