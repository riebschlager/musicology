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
    [path.join(repositoryRoot, "src/cli/benchmark-analytics.ts"), ...args],
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

describe("benchmark:analytics CLI", () => {
  it("reports aggregate-only analytical timings as JSON", () => {
    withTemporaryTestWorkspace((workspace) => {
      const result = runCli(workspace, ["--json"]);
      assert.equal(result.status, 0, result.stderr);
      const body = JSON.parse(result.stdout) as {
        readonly command: string;
        readonly data: {
          readonly canonicalEventCount: number;
          readonly measurements: readonly { readonly operation: string }[];
        };
      };
      assert.equal(body.command, "benchmark:analytics");
      assert.equal(body.data.canonicalEventCount, 0);
      assert.deepEqual(
        body.data.measurements.map((measurement) => measurement.operation),
        ["volume", "artist-eras", "rediscovery", "abandonment"],
      );
      assert.equal(result.stdout.includes("source_record"), false);
    });
  });

  it("rejects positional arguments with the stable usage category", () => {
    withTemporaryTestWorkspace((workspace) => {
      const result = runCli(workspace, ["unexpected"]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /does not accept positional arguments/u);
    });
  });
});
