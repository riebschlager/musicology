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
    [path.join(repositoryRoot, "src/cli/analyze-volume.ts"), ...args],
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

describe("analyze:volume CLI", () => {
  it("emits the versioned envelope as JSON and concise human output", () => {
    withTemporaryTestWorkspace((workspace) => {
      const json = runCli(workspace, ["--json", "--grain", "month"]);
      assert.equal(json.status, 0, json.stderr);
      const result = JSON.parse(json.stdout) as {
        readonly command: string;
        readonly data: {
          readonly analysis: string;
          readonly asOf: string | null;
          readonly dateRange: {
            readonly endExclusive: string;
            readonly startInclusive: string;
          } | null;
          readonly result: { readonly metricLabel: string };
        };
      };
      assert.equal(result.command, "analyze:volume");
      assert.equal(result.data.analysis, "listening-volume");
      assert.match(result.data.result.metricLabel, /all canonical/u);
      assert.equal(result.data.asOf, null);
      assert.equal(result.data.dateRange, null);
      const human = runCli(workspace, ["--metric", "listened_ms"]);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /Spotify-backed only/u);
      assert.equal(human.stdout.includes('"schemaVersion"'), false);
    });
  });

  it("rejects invalid or incomplete filters with a safe usage result", () => {
    withTemporaryTestWorkspace((workspace) => {
      const result = runCli(workspace, ["--json", "--from", "2024-01-01T00:00:00.000Z"]);
      assert.equal(result.status, 2);
      const body = JSON.parse(result.stderr) as {
        readonly errors: readonly { readonly code: string }[];
      };
      assert.equal(body.errors[0]?.code, "invalid_arguments");
    });
  });
});
