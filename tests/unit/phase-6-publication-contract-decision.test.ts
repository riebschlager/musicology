import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const decision = readFileSync(
  fileURLToPath(new URL("../../docs/decisions/phase-6-publication-contract.md", import.meta.url)),
  "utf8",
);

describe("P6-02 publication decision", () => {
  it("classifies every current private analytical and editorial candidate family", () => {
    for (const candidate of [
      "databaseState.canonicalSnapshotSha256",
      "Analytical envelope `analysis`",
      "Volume `metricLabel`",
      "Coverage `inputFiles[*].source/sha256`",
      "Artist era `intervals[*].artistId`",
      "Rediscovery `rediscoveries[*].entityId`",
      "Abandonment `artists[*].artistId`",
      "Genre `intervals[*].genreId`",
      "Authored `contentSchemaVersion`",
      "Publication `snapshotId`",
    ]) {
      assert.ok(decision.includes(candidate), `missing candidate classification: ${candidate}`);
    }
    for (const classification of [
      "Private-only",
      "Public aggregate",
      "Eligible artist detail",
      "Manually selected editorial detail",
    ]) {
      assert.ok(decision.includes(classification), `missing classification: ${classification}`);
    }
  });

  it("records every required granularity, selection, and sparse-group decision", () => {
    for (const decisionText of [
      "public-selection-policy-v1",
      "calendar months (`YYYY-MM`)",
      "calendar year (`YYYY`)",
      "at least **24** qualifying-window plays",
      "peak strength of at least **0.75**",
      "At most **200**",
      "manual-allowlist-only",
      "at most 600 history months",
      "zero and small monthly canonical play counts",
      "No “other artists” count",
    ]) {
      assert.ok(decision.includes(decisionText), `missing policy decision: ${decisionText}`);
    }
  });

  it("defines reviewable versioned schemas and the full publication lifecycle", () => {
    for (const schema of [
      "public-manifest-v1",
      "public-artifact-v1",
      "public-review-report-v1",
      "public-snapshot-generator-v1",
    ]) {
      assert.ok(decision.includes(schema), `missing schema: ${schema}`);
    }
    for (const step of [
      "**Generate:**",
      "**Validate and report:**",
      "**Review:**",
      "**Approve:**",
      "**Commit:**",
      "**Supersede:**",
      "**Withdraw:**",
      "**Rollback:**",
    ]) {
      assert.ok(decision.includes(step), `missing workflow step: ${step}`);
    }
    assert.match(decision, /reduced as-of date, common coverage, analytical versions/u);
    assert.match(decision, /exact executable field allowlist, record count, and proposed public/u);
    assert.match(decision, /Approval binds their\s+hashes; it never causes regeneration/u);
  });

  it("makes complete first-release third-party and privacy decisions", () => {
    for (const policy of [
      "permits **no downloadable data files**",
      "same-origin requests only",
      "No Spotify, Last.fm, MusicBrainz, or other third-party artist/album artwork",
      "system font stack",
      "Visitor analytics are **none**",
    ]) {
      assert.ok(decision.includes(policy), `missing publication policy: ${policy}`);
    }
    assert.match(decision, /no\s+individual listening log or private archive is published/u);
    assert.match(
      decision,
      /public contact\s+route for correction, licensing, or withdrawal requests/u,
    );
  });
});
