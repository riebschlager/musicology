import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const assessment = readFileSync(
  new URL("../../docs/phase-5-genre-enrichment-validation.md", import.meta.url),
  "utf8",
);

describe("P5-08 archive genre fitness assessment", () => {
  it("records aggregate coverage and an explicit experimental decision", () => {
    assert.match(assessment, /Status:\*\* experimental/u);
    assert.match(assessment, /22\.57%/u);
    assert.match(assessment, /41\.59%/u);
    assert.match(assessment, /Usable event coverage by year/u);
    assert.match(assessment, /2005 \| 3,532 \| 247 \| 6\.99%/u);
    assert.match(assessment, /2026 \| 3,171 \| 1,577 \| 49\.73%/u);
  });

  it("discloses every required genre-result boundary and next evidence gap", () => {
    for (const disclosure of [
      "musicbrainz",
      "genre-contribution-v2",
      "taxonomy version `null`",
      "weighting level `artist`",
      "180-day",
      "America/Chicago",
      "curated taxonomy artifact",
      "fallback provider",
    ]) {
      assert.ok(assessment.includes(disclosure), `missing ${disclosure}`);
    }
    assert.doesNotMatch(assessment, /data\/inputs\/(?:spotify|lastfm)\//u);
  });
});
