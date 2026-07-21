import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MATCH_TEXT_NORMALIZATION_VERSION,
  normalizeDisplayText,
  normalizeMatchText,
} from "../../../src/identity/normalization.ts";

describe("versioned matching-text normalization", () => {
  const cases: readonly {
    readonly expected: string | null;
    readonly name: string;
    readonly value: string;
  }[] = [
    { name: "canonical Unicode equivalence", value: "Beyonce\u0301", expected: "beyoncé" },
    { name: "punctuation", value: "P!nk: Don't Stop!", expected: "pnk dont stop" },
    { name: "Unicode whitespace", value: "  A\u00a0\t\nB  ", expected: "a b" },
    {
      name: "featuring notation",
      value: "Artist Featuring Guest ft. Another Feat. Third",
      expected: "artist feat guest feat another feat third",
    },
    {
      name: "marker-like substrings remain unchanged",
      value: "Defeating the Leftfield",
      expected: "defeating the leftfield",
    },
    {
      name: "meaningful qualifiers",
      value: "Suite No. 1: Movement I (Live Remix) [Radio Edit Version]",
      expected: "suite no 1 movement i live remix radio edit version",
    },
    { name: "blank values", value: " \t\n", expected: null },
  ];

  for (const testCase of cases) {
    it(`normalizes ${testCase.name}`, () => {
      assert.equal(normalizeMatchText(testCase.value), testCase.expected);
    });
  }

  it("gives canonically equivalent Unicode spellings the same matching value", () => {
    assert.equal(normalizeMatchText("Beyoncé"), normalizeMatchText("Beyonce\u0301"));
  });

  it("is deterministic and keeps display text separate from its matching value", () => {
    const displayText = "  Beyonce\u0301 feat. Jay-Z (Live)  ";
    const first = normalizeDisplayText(displayText);
    const second = normalizeDisplayText(displayText);

    assert.deepEqual(first, second);
    assert.deepEqual(first, {
      displayText,
      normalizedText: "beyoncé feat jayz live",
      normalizationVersion: MATCH_TEXT_NORMALIZATION_VERSION,
    });
  });
});
