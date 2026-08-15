import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { repositoryRoot } from "../../../src/config/config.ts";
import {
  generateAnalyticalExports,
  writeAnalyticalExports,
} from "../../../src/exports/analytics.ts";
import { readActivePublicSnapshot } from "../../../src/publication/workflow.ts";
import { emptyPublicationInput } from "../../fixtures/publication.ts";
import {
  type TemporaryTestWorkspace,
  withTemporaryTestWorkspace,
} from "../../helpers/temporary-workspace.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const cliPath = path.join(repositoryRoot, "src", "cli", "publication.ts");

function runCli(workspace: TemporaryTestWorkspace, args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MUSICOLOGY_DATA_DIR: workspace.configuration.paths.dataDirectory,
      MUSICOLOGY_DATABASE_PATH: workspace.configuration.paths.databasePath,
      MUSICOLOGY_INPUTS_DIR: workspace.configuration.paths.inputsDirectory,
      MUSICOLOGY_OUTPUTS_DIR: workspace.configuration.paths.outputsDirectory,
      MUSICOLOGY_PUBLICATION_DIR: workspace.configuration.paths.publicationDirectory,
      MUSICOLOGY_TIMEZONE: "America/Chicago",
    },
  });
}

function writeCurrentPrivateBundle(workspace: TemporaryTestWorkspace): void {
  const generated = generateAnalyticalExports({
    connection: workspace.connection,
    migrationsDirectory,
    presentationTimezone: "America/Chicago",
  });
  writeAnalyticalExports(workspace.configuration.paths.outputsDirectory, generated);
}

describe("P6-10 publication CLI", () => {
  it("generates, reviews, hash-confirms, approves, and activates without publishing automatically", () => {
    withTemporaryTestWorkspace((workspace) => {
      writeCurrentPrivateBundle(workspace);
      const snapshotId = "snapshot-2026-08-15-cli-empty";
      const inputPath = path.join(workspace.rootPath, "publication-input.json");
      writeFileSync(inputPath, `${JSON.stringify(emptyPublicationInput(snapshotId))}\n`, "utf8");

      const generated = runCli(workspace, [
        "generate",
        "--input",
        inputPath,
        "--generated-on",
        "2026-08-15",
        "--json",
      ]);
      assert.equal(generated.status, 0, generated.stderr);
      const generationResult = JSON.parse(generated.stdout) as {
        readonly data: {
          readonly reportSha256: string;
          readonly snapshotId: string;
          readonly state: string;
        };
      };
      assert.equal(generationResult.data.snapshotId, snapshotId);
      assert.equal(generationResult.data.state, "candidate");
      assert.equal(
        existsSync(path.join(workspace.configuration.paths.publicationDirectory, "active.json")),
        false,
      );

      const reviewed = runCli(workspace, ["review", "--snapshot", snapshotId, "--json"]);
      assert.equal(reviewed.status, 0, reviewed.stderr);
      assert.equal(
        (JSON.parse(reviewed.stdout) as { readonly data: { readonly reportSha256: string } }).data
          .reportSha256,
        generationResult.data.reportSha256,
      );

      const mismatchedApproval = runCli(workspace, [
        "approve",
        "--snapshot",
        snapshotId,
        "--decided-on",
        "2026-08-16",
        "--report-sha256",
        "0".repeat(64),
        "--json",
      ]);
      assert.equal(mismatchedApproval.status, 4);
      assert.match(mismatchedApproval.stderr, /confirmed review report hash does not match/u);

      const approved = runCli(workspace, [
        "approve",
        "--snapshot",
        snapshotId,
        "--decided-on",
        "2026-08-16",
        "--report-sha256",
        generationResult.data.reportSha256,
        "--json",
      ]);
      assert.equal(approved.status, 0, approved.stderr);
      assert.equal(
        (JSON.parse(approved.stdout) as { readonly data: { readonly state: string } }).data.state,
        "approved",
      );
      assert.equal(
        existsSync(path.join(workspace.configuration.paths.publicationDirectory, "active.json")),
        false,
      );

      const activated = runCli(workspace, ["activate", "--snapshot", snapshotId, "--json"]);
      assert.equal(activated.status, 0, activated.stderr);
      assert.equal(
        readActivePublicSnapshot(workspace.configuration.paths.publicationDirectory).snapshotId,
        snapshotId,
      );
    });
  });

  it("rejects path traversal and malformed release confirmations as usage errors", () => {
    withTemporaryTestWorkspace((workspace) => {
      for (const args of [
        ["review", "--snapshot", "../../data/inputs/private", "--json"],
        [
          "approve",
          "--snapshot",
          "snapshot-2026-08-15-safe",
          "--decided-on",
          "2026-08-15",
          "--report-sha256",
          "not-a-digest",
          "--json",
        ],
      ]) {
        const result = runCli(workspace, args);
        assert.equal(result.status, 2);
        assert.doesNotMatch(result.stderr, /private/u);
      }
    });
  });

  it("fails closed when the private analytical export is stale", () => {
    withTemporaryTestWorkspace((workspace) => {
      const inputPath = path.join(workspace.rootPath, "publication-input.json");
      writeFileSync(
        inputPath,
        `${JSON.stringify(emptyPublicationInput("snapshot-2026-08-15-stale"))}\n`,
        "utf8",
      );
      const result = runCli(workspace, [
        "generate",
        "--input",
        inputPath,
        "--generated-on",
        "2026-08-15",
        "--json",
      ]);
      assert.equal(result.status, 4);
      assert.match(result.stderr, /manifest_invalid/u);
      assert.equal(
        existsSync(
          path.join(workspace.configuration.paths.outputsDirectory, "publication-candidates"),
        ),
        false,
      );
    });
  });
});
