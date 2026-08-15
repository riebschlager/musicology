import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const decision = readFileSync(
  new URL("../../docs/decisions/phase-6-static-web-visualization-stack.md", import.meta.url),
  "utf8",
);

describe("P6-03 static web and visualization stack decision", () => {
  it("names every required strategy and the selected static stack", () => {
    for (const concern of [
      "Build and runtime",
      "Data loading",
      "Charting",
      "Interaction",
      "Styling",
      "Testing",
      "Accessibility",
      "Publication",
    ]) {
      assert.match(decision, new RegExp(`\\| ${concern} \\|`, "u"), `missing ${concern}`);
    }

    for (const selection of [
      "Astro static output",
      "Preact islands",
      "Observable Plot",
      "Project-owned SVG is an exception",
      'output: "static"',
      'site: "https://music.the816.com"',
    ]) {
      assert.ok(decision.includes(selection), `missing selection: ${selection}`);
    }
  });

  it("records pinned-toolchain and static Pages compatibility evidence", () => {
    for (const evidence of [
      "Node `24.15.0`",
      "pnpm `9.0.0`",
      "TypeScript `7.0.2`",
      "strict peer-dependency",
      "Installation,\n`astro build`, and `tsc --noEmit` passed",
      "one static `index.html` plus hashed client\nassets",
      "about 90 KiB gzip",
      "site/dist/",
      "protected `github-pages` environment",
    ]) {
      assert.ok(decision.includes(evidence), `missing compatibility evidence: ${evidence}`);
    }
    assert.match(decision, /deliberately adds no site dependency,\ncommand, route, workflow/u);
  });

  it("records the scoped P6-05 diagnostic fallback until Astro check supports TypeScript 7", () => {
    assert.match(
      decision,
      /`astro build` transpiles but\ndoes not type-check `.astro` files, and `tsc` ignores those files/u,
    );
    assert.match(
      decision,
      /P6-05 amendment \(2026-08-15\).*prohibition on adding `.astro` source without a\ncompatible `astro check` release is removed/su,
    );
    assert.match(
      decision,
      /strict `tsc` over all site `.ts`\/`.tsx` logic,\ndeterministic adapter and view-model tests, an Astro production build, and built-HTML assertions/u,
    );
    assert.match(
      decision,
      /will not suppress that peer\nconflict or downgrade the repository compiler/u,
    );
    assert.match(
      decision,
      /Adding a compatible `astro check` command remains a future\ntoolchain improvement/u,
    );
  });

  it("defines project-owned boundaries without a private or runtime data path", () => {
    for (const boundary of [
      "`src/publication/`",
      "`data/publication/`",
      "`site/src/adapters/`",
      "`site/src/view-models/`",
      "`site/src/components/`",
      "`site/src/islands/`",
      "`site/src/charts/`",
      "`site/src/content/`",
      "`site/src/styles/`",
      "`site/src/pages/`",
    ]) {
      assert.ok(decision.includes(boundary), `missing boundary: ${boundary}`);
    }

    assert.match(decision, /It reads at build time only/u);
    assert.match(decision, /not files copied wholesale into the deployed output/u);
    assert.match(decision, /There is no browser `fetch\(\)` to a\nprivate or public API/u);
    assert.match(decision, /does not add MDX or an Astro content\ncollection as a parallel/u);
  });

  it("defines deterministic testing, accessibility, visual, performance, and browser policies", () => {
    for (const testingLayer of [
      "Vitest",
      "Preact Testing Library",
      "Playwright",
      "@axe-core/playwright",
      "JavaScript-disabled",
      "pinned Linux Chromium",
      "VoiceOver",
      "NVDA",
      "current and previous stable major releases",
    ]) {
      assert.ok(decision.includes(testingLayer), `missing test policy: ${testingLayer}`);
    }

    for (const budget of [
      "0 KiB of route-authored client JavaScript",
      "125 KiB gzip of initial client JavaScript",
      "75 KiB gzip",
      "150 KiB uncompressed",
      "250 KiB\n  gzip",
      "zero automatic third-party requests",
      "LCP at or below 2.5 seconds",
      "CLS at or below 0.1",
      "INP at or below 200",
    ]) {
      assert.ok(decision.includes(budget), `missing budget: ${budget}`);
    }
  });

  it("explains why no hosted runtime or monorepo is required", () => {
    assert.match(decision, /No route needs a runtime query to render its default\nstate/u);
    assert.match(
      decision,
      /no demonstrated deployment or ownership boundary that would justify a\nserver runtime, hosted database, or second package/u,
    );
    assert.match(decision, /A workspace\/monorepo split/u);
    assert.match(decision, /Astro live content loaders, SSR, or a hosted database\/API/u);
    assert.match(
      decision,
      /Adding a server adapter, hosted database\/API, SPA router, second package/u,
    );
  });
});
