import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";

import type { SqliteRow } from "../../../src/db/connection.ts";
import { repositoryRoot } from "../../../src/config/config.ts";
import { buildLastfmScrobbleFixture } from "../../fixtures/lastfm.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

interface CountRow extends SqliteRow {
  readonly count: number;
}

function runCli(workspace: TemporaryTestWorkspace, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "src/cli/import-lastfm-export.ts"), ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MUSICOLOGY_DATABASE_PATH: workspace.configuration.paths.databasePath,
        MUSICOLOGY_INPUTS_DIR: workspace.configuration.paths.inputsDirectory,
      },
    },
  );
}

describe("import:lastfm-export CLI", () => {
  it("imports explicit paths with structured JSON and a concise human no-op summary", () => {
    withTemporaryTestWorkspace((workspace) => {
      const privateMarker = "synthetic-lastfm-cli-sensitive-marker";
      const scrobble = buildLastfmScrobbleFixture();
      const fixturePath = workspace.writeJsonFixture("lastfm/history-cli.json", [
        { ...scrobble, unknown_private_field: privateMarker },
        { ...scrobble },
        buildLastfmScrobbleFixture({ timestamp: "invalid" }),
      ]);

      const imported = runCli(workspace, ["--json", fixturePath]);
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(imported.stderr, "");
      assert.equal(imported.stdout.includes(privateMarker), false);
      assert.deepEqual(JSON.parse(imported.stdout), {
        command: "import:lastfm-export",
        status: "success",
        exitCode: 0,
        summary: "Last.fm export import completed: 2 accepted, 1 duplicated, 1 rejected.",
        data: {
          runId: 1,
          noOp: false,
          fingerprintVersions: {
            source: "lastfm-source-v1",
            overlap: "lastfm-overlap-v1",
          },
          files: { discovered: 1, registered: 1, noOp: 0, unsupported: 0 },
          records: { discovered: 3, accepted: 2, duplicated: 1, excluded: 0, rejected: 1 },
        },
      });

      const unchanged = runCli(workspace, [fixturePath]);
      assert.equal(unchanged.status, 0, unchanged.stderr);
      assert.equal(unchanged.stderr, "");
      assert.match(unchanged.stdout, /completed as a no-op/);
      assert.equal(
        workspace.connection
          .prepare<CountRow>("SELECT count(*) AS count FROM lastfm_scrobble_occurrence")
          .get()?.count,
        2,
      );
    });
  });

  it("requires at least one explicit export path", () => {
    withTemporaryTestWorkspace((workspace) => {
      const result = runCli(workspace, ["--json"]);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      const failure = JSON.parse(result.stderr) as {
        readonly errors: readonly { readonly code: string }[];
        readonly exitCode: number;
      };
      assert.equal(failure.exitCode, 2);
      assert.equal(failure.errors[0]?.code, "invalid_arguments");
    });
  });
});
