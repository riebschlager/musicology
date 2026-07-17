import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);

function readProjectFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, repositoryRoot), "utf8");
}

describe("foundation developer workflow", () => {
  it("uses the pinned runtime, locked install, and shared project entry points in CI", () => {
    const workflow = readProjectFile(".github/workflows/ci.yml");

    assert.match(workflow, /node-version-file: \.node-version/);
    assert.match(workflow, /corepack install/);
    assert.match(workflow, /pnpm install --frozen-lockfile/);
    assert.match(workflow, /run: pnpm quality/);
    assert.match(workflow, /run: pnpm db:migrate --json/);
    assert.match(workflow, /run: pnpm db:status --json/);
  });

  it("keeps CI isolated from private inputs and secrets", () => {
    const workflow = readProjectFile(".github/workflows/ci.yml");

    assert.match(workflow, /MUSICOLOGY_DATA_DIR: \$\{\{ runner\.temp \}\}\/musicology-data/);
    assert.doesNotMatch(workflow, /data\/inputs/);
    assert.doesNotMatch(workflow, /LASTFM_(?:API_KEY|USERNAME)/);
    assert.doesNotMatch(workflow, /secrets\./);
  });

  it("documents every required fresh-checkout workflow", () => {
    const documentation = readProjectFile("docs/developer-workflow.md");

    for (const requiredCommand of [
      "pnpm install --frozen-lockfile",
      "pnpm db:migrate",
      "pnpm db:status",
      "pnpm test",
      "pnpm quality",
    ]) {
      assert.ok(documentation.includes(requiredCommand), `missing ${requiredCommand}`);
    }

    assert.match(documentation, /Rebuild the generated database/);
    assert.match(documentation, /Privacy-safe troubleshooting/);
  });
});
