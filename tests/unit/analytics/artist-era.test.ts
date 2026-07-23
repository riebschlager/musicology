import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ARTIST_ERA_PARAMETERS,
  alignArtistEraWindowStart,
  evaluateArtistEraWindow,
  validateArtistEraParameters,
} from "../../../src/analytics/artist-era.ts";
import { AnalyticalResultContractError } from "../../../src/analytics/result.ts";

describe("artist-era parameter and component contract", () => {
  it("uses documented conservative defaults and keeps every threshold configurable", () => {
    assert.deepEqual(DEFAULT_ARTIST_ERA_PARAMETERS, {
      maximumRank: 20,
      minimumConsecutiveActiveWindows: 2,
      minimumEarlierBaselineChange: -12,
      minimumListeningShare: 0.02,
      minimumRollingPlayCount: 12,
      minimumWindowPlayCount: 3,
      rollingWindowCount: 4,
      windowSizeMonths: 3,
    });
    assert.deepEqual(validateArtistEraParameters({ windowSizeMonths: 6, maximumRank: 10 }), {
      ...DEFAULT_ARTIST_ERA_PARAMETERS,
      maximumRank: 10,
      windowSizeMonths: 6,
    });
  });

  it("accepts documented parameter limits and rejects values beyond them", () => {
    const maximumParameters = {
      maximumRank: 100_000,
      minimumConsecutiveActiveWindows: 100,
      rollingWindowCount: 24,
      windowSizeMonths: 12,
    };
    assert.deepEqual(validateArtistEraParameters(maximumParameters), {
      ...DEFAULT_ARTIST_ERA_PARAMETERS,
      ...maximumParameters,
    });
    assert.throws(() => validateArtistEraParameters({ windowSizeMonths: 13 }), /windowSizeMonths/);
    assert.throws(
      () => validateArtistEraParameters({ rollingWindowCount: 25 }),
      /rollingWindowCount/,
    );
    assert.throws(() => validateArtistEraParameters({ maximumRank: 100_001 }), /maximumRank/);
    assert.throws(
      () => validateArtistEraParameters({ minimumConsecutiveActiveWindows: 101 }),
      /minimumConsecutiveActiveWindows/,
    );
  });

  it("prevents a low-volume artist with a dominant share from qualifying", () => {
    const components = evaluateArtistEraWindow({
      consecutiveActiveWindows: 2,
      earlierBaselineRollingPlayCount: 0,
      listeningShare: 1,
      rank: 1,
      rollingPlayCount: 2,
      windowPlayCount: 2,
    });
    assert.equal(components.isQualified, false);
    assert.equal(components.earlierBaselineChange, 2);
  });

  it("anchors every calendar-window cadence at January 1970", () => {
    assert.deepEqual(alignArtistEraWindowStart({ year: 2026, month: 2 }), {
      year: 2026,
      month: 1,
    });
    assert.deepEqual(alignArtistEraWindowStart({ year: 2026, month: 4 }), {
      year: 2026,
      month: 4,
    });
    assert.deepEqual(alignArtistEraWindowStart({ year: 2026, month: 2 }, { windowSizeMonths: 5 }), {
      year: 2025,
      month: 11,
    });
    assert.deepEqual(alignArtistEraWindowStart({ year: 2026, month: 6 }, { windowSizeMonths: 5 }), {
      year: 2026,
      month: 4,
    });
  });

  it("qualifies exact threshold values and treats the baseline boundary inclusively", () => {
    const components = evaluateArtistEraWindow({
      consecutiveActiveWindows: 2,
      earlierBaselineRollingPlayCount: 24,
      listeningShare: 0.02,
      rank: 20,
      rollingPlayCount: 12,
      windowPlayCount: 3,
    });
    assert.deepEqual(components, {
      consecutiveActiveWindows: 2,
      earlierBaselineChange: -12,
      earlierBaselineRollingPlayCount: 24,
      isQualified: true,
      listeningShare: 0.02,
      rank: 20,
      rollingPlayCount: 12,
      strength: 0.6749999999999999,
      windowPlayCount: 3,
    });
  });

  it("preserves an unavailable earlier baseline rather than inventing zero activity", () => {
    const components = evaluateArtistEraWindow({
      consecutiveActiveWindows: 2,
      earlierBaselineRollingPlayCount: null,
      listeningShare: 0.04,
      rank: 5,
      rollingPlayCount: 16,
      windowPlayCount: 4,
    });
    assert.equal(components.earlierBaselineChange, null);
    assert.equal(components.isQualified, true);
    assert.equal(components.strength, 0.96);
  });

  it("rejects unsupported, impossible, and privacy-irrelevant parameter shapes at the boundary", () => {
    assert.throws(
      () => validateArtistEraParameters({ accountUsername: "not allowed" }),
      AnalyticalResultContractError,
    );
    assert.throws(
      () => validateArtistEraParameters({ minimumListeningShare: 0 }),
      /minimumListeningShare/,
    );
    assert.throws(
      () =>
        evaluateArtistEraWindow({
          consecutiveActiveWindows: 1,
          earlierBaselineRollingPlayCount: null,
          listeningShare: 1.1,
          rank: 1,
          rollingPlayCount: 1,
          windowPlayCount: 1,
        }),
      /listeningShare/,
    );
    assert.throws(
      () =>
        evaluateArtistEraWindow({
          consecutiveActiveWindows: 1,
          earlierBaselineRollingPlayCount: null,
          listeningShare: Number.NaN,
          rank: 1,
          rollingPlayCount: 1,
          windowPlayCount: 1,
        }),
      /listeningShare/,
    );
    assert.throws(() => alignArtistEraWindowStart({ year: 2026, month: 13 }), /calendar month/);
  });
});
