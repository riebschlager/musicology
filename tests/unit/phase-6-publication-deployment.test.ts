import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

function read(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");
}

describe("P6-10 reviewed publication and GitHub Pages deployment", () => {
  it("exposes separate candidate, review, approval, activation, build, and live verification commands", () => {
    const packageJson = JSON.parse(read("../../package.json")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    assert.equal(
      packageJson.scripts["publication:generate"],
      "node --env-file-if-exists=.env src/cli/publication.ts generate",
    );
    assert.equal(
      packageJson.scripts["publication:review"],
      "node --env-file-if-exists=.env src/cli/publication.ts review",
    );
    assert.equal(
      packageJson.scripts["publication:approve"],
      "node --env-file-if-exists=.env src/cli/publication.ts approve",
    );
    assert.equal(
      packageJson.scripts["publication:activate"],
      "node --env-file-if-exists=.env src/cli/publication.ts activate",
    );
    assert.equal(
      packageJson.scripts["publication:build"],
      "pnpm run site:build && pnpm run site:verify",
    );
    assert.equal(
      packageJson.scripts["site:verify:deployed"],
      "node --env-file-if-exists=.env site/scripts/verify-deployed-site.ts",
    );
  });

  it("keeps fixture and pull-request CI unable to publish", () => {
    const ci = read("../../.github/workflows/ci.yml");
    assert.match(ci, /pull_request:/u);
    assert.doesNotMatch(ci, /pages:\s*write/u);
    assert.doesNotMatch(ci, /deploy-pages/u);
    assert.doesNotMatch(ci, /publication:(?:generate|approve|activate)/u);
  });

  it("deploys only a verified committed snapshot through the protected Pages environment", () => {
    const workflow = read("../../.github/workflows/pages.yml");
    assert.match(workflow, /push:\n\s+branches:\n\s+- main/u);
    assert.match(workflow, /workflow_dispatch:/u);
    assert.doesNotMatch(workflow, /pull_request:/u);
    assert.match(workflow, /run: pnpm quality/u);
    assert.match(workflow, /run: pnpm publication:build/u);
    assert.match(workflow, /uses: actions\/upload-pages-artifact@v5/u);
    assert.match(workflow, /needs: build/u);
    assert.match(workflow, /name: github-pages/u);
    assert.match(workflow, /pages: write/u);
    assert.match(workflow, /id-token: write/u);
    assert.match(workflow, /uses: actions\/deploy-pages@v5/u);
    assert.match(workflow, /verify-deployed-site\.ts --attempts 12 --delay-ms 5000/u);
    assert.doesNotMatch(workflow, /publication:(?:generate|approve|activate)/u);

    const deployIndex = workflow.indexOf("  deploy:");
    assert.ok(deployIndex > 0);
    assert.doesNotMatch(workflow.slice(0, deployIndex), /pages:\s*write/u);
  });

  it("fixes the custom origin and documents manual approval, DNS, HTTPS, cadence, and rollback", () => {
    assert.equal(read("../../site/public/CNAME"), "music.the816.com\n");
    assert.match(read("../../site/astro.config.ts"), /site: "https:\/\/music\.the816\.com"/u);
    const runbook = read("../../docs/publication-release.md");
    for (const required of [
      "There is no automatic refresh cadence",
      "--report-sha256",
      "protected `github-pages` environment",
      "`riebschlager.github.io`",
      "Enforce HTTPS",
      "pnpm publication:build",
      "pnpm site:verify:deployed",
      "pnpm publication:activate --snapshot snapshot-YYYY-MM-DD-prior",
      "require no private input, SQLite database, analytical",
    ]) {
      assert.ok(runbook.includes(required), `missing P6-10 release guidance: ${required}`);
    }
  });
});
