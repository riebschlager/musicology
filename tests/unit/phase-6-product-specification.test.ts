import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const specification = readFileSync(
  new URL("../../docs/public-microsite-product-specification.md", import.meta.url),
  "utf8",
);

const routeHeadings = [
  "/",
  "/history/",
  "/artists/",
  "/artists/[artistSlug]/",
  "/stories/",
  "/stories/[storySlug]/",
  "/explore/",
  "/methodology/",
  "/lab/genres/",
] as const;

const journeyFields = [
  "Question",
  "Narrative role",
  "Default view",
  "Filters",
  "URL-addressable state",
  "Drill-down",
  "Supporting input",
  "Uncertainty disclosure",
  "Empty state",
  "Tabular alternative",
  "Bounded export/share action",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function routeSection(route: (typeof routeHeadings)[number]): string {
  const heading = `### Route: \`${route}\``;
  const start = specification.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const next = specification.indexOf("\n### Route: ", start + heading.length);
  return specification.slice(start, next === -1 ? specification.length : next);
}

describe("P6-01 public microsite product specification", () => {
  it("defines the audience, narrative promise, and first-release story", () => {
    assert.match(specification, /curious reader/u);
    assert.match(specification, /long-form personal music history with an analytical explorer/u);
    assert.match(specification, /not an\s+internal dashboard/u);
    assert.match(specification, /not a generic streaming recap/u);
    assert.match(specification, /## First-release narrative/u);
    assert.match(specification, /The ending is still being observed/u);
  });

  for (const route of routeHeadings) {
    it(`documents every required journey field for ${route}`, () => {
      const section = routeSection(route);
      for (const field of journeyFields) {
        assert.match(section, new RegExp(`- \\*\\*${escapeRegExp(field)}:`, "u"));
      }
    });
  }

  it("maps every stable analytical artifact and authored content boundary", () => {
    for (const input of [
      "volume.json",
      "coverage.json",
      "artist-eras.json",
      "rediscovery.json",
      "abandonment.json",
      "genre-eras.json",
      "Versioned authored public content",
      "Approved public manifest",
    ]) {
      assert.ok(specification.includes(input), `missing ${input}`);
    }
    assert.match(specification, /private analytical bundle is an upstream source/u);
    assert.match(specification, /site\s+will eventually read only the narrower approved public/u);
  });

  it("keeps the experimental genre route conditional and fully qualified", () => {
    const section = routeSection("/lab/genres/");
    const normalizedSection = section.replace(/\s+/gu, " ");
    for (const disclosure of [
      "experimental",
      "musicbrainz",
      "raw",
      "taxonomy `null`",
      "artist-level weighting",
      "freshness",
      "usable-event coverage",
      "P6-09",
    ]) {
      assert.ok(normalizedSection.includes(disclosure), `missing genre disclosure ${disclosure}`);
    }
    assert.match(section, /if deferred, neither its HTML nor\s+data ships/u);
  });

  it("separates authored narrative from approved analytical and track selections", () => {
    for (const model of ["### Annotation", "### Featured artist", "### Selected track story"]) {
      assert.ok(specification.includes(model), `missing ${model}`);
    }
    assert.match(specification, /track-selection allowlist is authoritative/u);
    assert.match(specification, /never a database ID/u);
    assert.match(specification, /No story can enumerate the track's plays/u);
  });

  it("establishes the complete accessible progressive-enhancement baseline", () => {
    for (const requirement of [
      "320 CSS pixels",
      "200% zoom",
      "keyboard alone",
      "Screen readers",
      "WCAG 2.2 AA",
      "prefers-reduced-motion: reduce",
      "With JavaScript disabled",
      "Color, shape, motion, hover, and spatial position never carry meaning alone",
    ]) {
      assert.ok(specification.includes(requirement), `missing ${requirement}`);
    }
  });

  it("requires only static public interfaces and forbids event-level exploration", () => {
    assert.match(
      specification,
      /has no requirement for raw export access, a SQLite connection, a production\s+server, a hosted database\/query service, visitor accounts, or an event-level listening log/u,
    );
    assert.match(specification, /cannot\s+issue a database, API, or hosted-service query/u);
    assert.match(specification, /There is no route for .* an individual event/u);
  });
});
