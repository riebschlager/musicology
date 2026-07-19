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

    assert.match(workflow, /uses: actions\/checkout@v6/);
    assert.match(workflow, /uses: actions\/setup-node@v6/);
    assert.match(workflow, /node-version-file: \.node-version/);
    assert.match(workflow, /corepack install/);
    assert.match(workflow, /pnpm install --frozen-lockfile/);
    assert.match(workflow, /run: pnpm quality/);
    assert.match(workflow, /run: pnpm db:migrate --json/);
    assert.match(workflow, /run: pnpm db:status --json/);
  });

  it("keeps CI isolated from private inputs and secrets", () => {
    const workflow = readProjectFile(".github/workflows/ci.yml");

    assert.match(workflow, /MUSICOLOGY_DATA_DIR=\$RUNNER_TEMP\/musicology-data/);
    assert.match(workflow, />> "\$GITHUB_ENV"/);
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

  it("documents historical imports without pnpm echoing private source paths", () => {
    for (const relativePath of [
      "README.md",
      "docs/configuration-and-cli.md",
      "docs/developer-workflow.md",
    ]) {
      const documentation = readProjectFile(relativePath);
      const importCommands = documentation
        .split("\n")
        .filter((line) => /^pnpm .*import:(?:spotify|lastfm-export)/u.test(line));
      assert.ok(importCommands.length > 0, `missing historical import command in ${relativePath}`);
      assert.ok(
        importCommands.every((line) => line.startsWith("pnpm --silent import:")),
        `historical import command can echo a private source path in ${relativePath}`,
      );
    }
  });
});
