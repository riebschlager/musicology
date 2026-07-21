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
  return spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "src/cli/report-coverage.ts"), ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MUSICOLOGY_DATABASE_PATH: databasePath,
        MUSICOLOGY_INPUTS_DIR: workspace.configuration.paths.inputsDirectory,
        MUSICOLOGY_TIMEZONE: "America/Chicago",
      },
    },
  );
}

describe("report:coverage CLI", () => {
  it("emits deterministic structured coverage metadata in JSON mode", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, ["--json", "--compare-archive-baseline"]);

      assert.equal(completed.status, 0, completed.stderr);
      assert.equal(completed.stderr, "");
      const result = JSON.parse(completed.stdout) as {
        readonly command: string;
        readonly data: {
          readonly archiveBaselineComparison: { readonly matches: boolean };
          readonly reportVersion: string;
          readonly semantics: { readonly canonicalEventCountsIncluded: boolean };
          readonly timezone: string;
          readonly totals: { readonly evidenceOccurrences: number };
        };
        readonly status: string;
      };
      assert.equal(result.command, "report:coverage");
      assert.equal(result.status, "success");
      assert.equal(result.data.reportVersion, "coverage-v2");
      assert.equal(result.data.timezone, "America/Chicago");
      assert.equal(result.data.totals.evidenceOccurrences, 0);
      assert.equal(result.data.semantics.canonicalEventCountsIncluded, true);
      assert.equal(result.data.archiveBaselineComparison.matches, false);
    });
  });

  it("keeps human output concise and distinguishes evidence from canonical events", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, []);

      assert.equal(completed.status, 0, completed.stderr);
      assert.equal(completed.stderr, "");
      assert.match(completed.stdout, /Source counts are evidence occurrences/u);
      assert.match(completed.stdout, /canonical current or unresolved events: 0/u);
      assert.match(completed.stdout, /spotify: 0 evidence/u);
      assert.match(completed.stdout, /lastfm: 0 evidence/u);
      assert.equal(completed.stdout.includes('"sources"'), false);
    });
  });

  it("rejects positional arguments", () => {
    withTemporaryTestWorkspace((workspace) => {
      const completed = runCli(workspace, ["--json", "unexpected"]);

      assert.equal(completed.status, 2);
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
        readonly errors: readonly { readonly code: string; readonly message: string }[];
      };
      assert.equal(result.errors[0]?.code, "database_not_ready");
      assert.equal(completed.stderr.includes(missingDatabase), false);
      assert.equal(existsSync(missingDatabase), false);
      assert.equal(existsSync(missingParent), false);
    });
  });

  it("rejects a database with pending migrations using a safe data error", () => {
    withTemporaryTestWorkspace((workspace) => {
      workspace.connection
        .prepare(
          "DELETE FROM schema_migration WHERE version = (SELECT max(version) FROM schema_migration)",
        )
        .run();

      const completed = runCli(workspace, ["--json"]);

      assert.equal(completed.status, 4);
      assert.equal(completed.stdout, "");
      const result = JSON.parse(completed.stderr) as {
        readonly errors: readonly { readonly code: string; readonly message: string }[];
      };
      assert.equal(result.errors[0]?.code, "database_not_ready");
      assert.equal(
        result.errors[0]?.message,
        "Database migrations must be current before reporting historical evidence coverage",
      );
      assert.equal(completed.stderr.includes(workspace.configuration.paths.databasePath), false);
    });
  });
});
