import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ANALYTICAL_RESULT_SCHEMA_VERSION,
  AnalyticalResultContractError,
  createAnalyticalResult,
  serializeAnalyticalResult,
  validateAnalyticalParameters,
} from "../../../src/analytics/result.ts";

function representativeInput() {
  return {
    analysis: "listening-volume",
    asOf: "2026-01-03T00:00:00.000Z",
    dateRange: {
      endExclusive: "2026-01-03T00:00:00.000Z",
      startInclusive: "2026-01-01T00:00:00.000Z",
    },
    definition: "Counts current canonical track events by calendar day.",
    eventCount: 3,
    includedSources: ["spotify", "lastfm"] as const,
    metadataCoverage: {
      spotifyDuration: { availableEventCount: 2, rate: 2 / 3, totalEventCount: 3 },
    },
    parameters: { grain: "day", includeUnresolved: false },
    presentationTimezone: "America/Chicago",
    result: { rows: [{ date: "2026-01-01", playCount: 3 }] },
    unresolvedRate: 1 / 3,
    versions: {
      analysis: "volume-v1",
      identityRules: ["identity-resolution-v1"],
      parameterSchema: "volume-parameters-v1",
      query: "canonical-volume-v1",
      reconciliationRules: ["canonical-event-v1", "cross-source-decision-policy-v1"],
    },
  };
}

describe("analytical result envelope", () => {
  it("includes every disclosure field and normalizes deterministic collections", () => {
    const result = createAnalyticalResult(representativeInput());

    assert.equal(result.schemaVersion, ANALYTICAL_RESULT_SCHEMA_VERSION);
    assert.deepEqual(result.includedSources, ["lastfm", "spotify"]);
    assert.deepEqual(result.versions.reconciliationRules, [
      "canonical-event-v1",
      "cross-source-decision-policy-v1",
    ]);
    assert.deepEqual(Object.keys(result.metadataCoverage), ["spotifyDuration"]);
  });

  it("rejects missing analytical context and invalid disclosure values", () => {
    const missingSources = representativeInput();
    assert.throws(
      () => createAnalyticalResult({ ...missingSources, includedSources: [] }),
      AnalyticalResultContractError,
    );
    assert.throws(
      () => createAnalyticalResult({ ...representativeInput(), definition: "" }),
      /Definition must be non-empty/,
    );
    assert.throws(
      () => createAnalyticalResult({ ...representativeInput(), presentationTimezone: "local" }),
      /valid IANA timezone/,
    );
    assert.throws(
      () =>
        createAnalyticalResult({
          ...representativeInput(),
          unresolvedRate: 1.1,
        }),
      /Unresolved rate/,
    );
    assert.throws(
      () =>
        createAnalyticalResult({
          ...representativeInput(),
          metadataCoverage: {
            spotifyDuration: { availableEventCount: 2, rate: 0.5, totalEventCount: 3 },
          },
        }),
      /must equal available event count/,
    );
    assert.throws(
      () =>
        createAnalyticalResult({
          ...representativeInput(),
          metadataCoverage: {
            spotifyDuration: { availableEventCount: 2, rate: 1, totalEventCount: 2 },
          },
        }),
      /must equal result event count/,
    );
    assert.throws(
      () =>
        createAnalyticalResult({
          ...representativeInput(),
          parameters: { generatedAt: new Date("2026-01-01T00:00:00.000Z") } as never,
        }),
      /plain JSON objects/,
    );
  });

  it("returns contract errors for missing or malformed nested context", () => {
    const invalidInputs: unknown[] = [
      undefined,
      { ...representativeInput(), dateRange: undefined },
      { ...representativeInput(), includedSources: null },
      { ...representativeInput(), metadataCoverage: { spotifyDuration: null } },
      { ...representativeInput(), versions: undefined },
    ];

    for (const input of invalidInputs) {
      assert.throws(() => createAnalyticalResult(input as never), AnalyticalResultContractError);
    }
  });

  it("records a versioned TypeScript parameter validator and rejects invalid parameters", () => {
    const definition = {
      schemaVersion: "volume-parameters-v1",
      validate(input: unknown) {
        if (
          input === null ||
          typeof input !== "object" ||
          (input as { grain?: unknown }).grain !== "day"
        ) {
          throw new AnalyticalResultContractError("grain must be day");
        }
        return { grain: "day" };
      },
    };

    assert.deepEqual(validateAnalyticalParameters(definition, { grain: "day" }), {
      schemaVersion: "volume-parameters-v1",
      values: { grain: "day" },
    });
    assert.throws(
      () => validateAnalyticalParameters(definition, { grain: "month" }),
      /grain must be day/,
    );
  });

  it("rejects excluded source and credential fields without echoing their values", () => {
    const privateValue = "synthetic-analytical-private-marker";
    const assertPrivacySafeRejection = (error: unknown) => {
      assert.ok(error instanceof AnalyticalResultContractError);
      assert.match(error.message, /excluded private fields/);
      assert.equal(error.message.includes(privateValue), false);
      return true;
    };

    assert.throws(
      () =>
        createAnalyticalResult({
          ...representativeInput(),
          parameters: { apiKey: privateValue },
        }),
      assertPrivacySafeRejection,
    );
    assert.throws(
      () =>
        createAnalyticalResult({
          ...representativeInput(),
          result: { rows: [{ ip_addr: privateValue }] },
        }),
      assertPrivacySafeRejection,
    );
  });

  it("serializes equivalent results deterministically regardless of object insertion order", () => {
    const first = createAnalyticalResult(representativeInput());
    const second = createAnalyticalResult({
      ...representativeInput(),
      parameters: { includeUnresolved: false, grain: "day" },
      result: { rows: [{ playCount: 3, date: "2026-01-01" }] },
    });

    assert.equal(serializeAnalyticalResult(first), serializeAnalyticalResult(second));
    assert.equal(serializeAnalyticalResult(first).endsWith("\n"), true);
  });

  it("uses locale-independent ordering for Unicode JSON keys", () => {
    const first = createAnalyticalResult({
      ...representativeInput(),
      parameters: { ä: false, a: true, Z: false },
    });
    const second = createAnalyticalResult({
      ...representativeInput(),
      parameters: { Z: false, ä: false, a: true },
    });

    const serialized = serializeAnalyticalResult(first);
    assert.equal(serialized, serializeAnalyticalResult(second));
    assert.match(serialized, /"parameters":\{"Z":false,"a":true,"ä":false\}/u);
  });
});
