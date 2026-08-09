import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalizeGenreTaxonomyArtifact,
  parseGenreTaxonomyArtifact,
  type GenreTaxonomyArtifact,
} from "../../../src/genre/taxonomy.ts";

function artifact(overrides: Partial<GenreTaxonomyArtifact> = {}): GenreTaxonomyArtifact {
  return {
    artifactVersion: "genre-taxonomy-v1",
    taxonomyVersion: "synthetic-v1",
    categories: [
      { id: "electronic", label: "Electronic", parentId: null },
      { id: "dream-pop", label: "Dream Pop", parentId: "electronic" },
    ],
    mappings: [
      { sourceTag: "dream pop", action: "rename", targetCategoryId: "dream-pop" },
      { sourceTag: "synthpop", action: "combine", targetCategoryId: "dream-pop" },
      { sourceTag: "noise", action: "ignore", targetCategoryId: null },
    ],
    ...overrides,
  };
}

describe("P5-05 genre taxonomy artifact", () => {
  it("accepts keep, combine, rename, ignore, and parent-child taxonomy decisions", () => {
    assert.deepEqual(parseGenreTaxonomyArtifact(artifact()), artifact());
  });

  it("rejects cyclic, duplicate, conflicting, and unknown-category mappings", () => {
    assert.throws(
      () =>
        parseGenreTaxonomyArtifact(
          artifact({
            categories: [
              { id: "a", label: "A", parentId: "b" },
              { id: "b", label: "B", parentId: "a" },
            ],
          }),
        ),
      /cycle/u,
    );
    assert.throws(
      () =>
        parseGenreTaxonomyArtifact(
          artifact({
            mappings: [
              { sourceTag: "dream pop", action: "keep", targetCategoryId: "dream-pop" },
              { sourceTag: "dream pop", action: "ignore", targetCategoryId: null },
            ],
          }),
        ),
      /duplicate/u,
    );
    assert.throws(
      () =>
        parseGenreTaxonomyArtifact(
          artifact({
            mappings: [{ sourceTag: "dream pop", action: "ignore", targetCategoryId: "dream-pop" }],
          }),
        ),
      /Ignored/u,
    );
    assert.throws(
      () =>
        parseGenreTaxonomyArtifact(
          artifact({
            mappings: [{ sourceTag: "dream pop", action: "rename", targetCategoryId: "missing" }],
          }),
        ),
      /unknown category/u,
    );
  });

  it("sorts portable exports deterministically", () => {
    const reversed = artifact({
      categories: [...artifact().categories].reverse(),
      mappings: [...artifact().mappings].reverse(),
    });
    assert.deepEqual(
      canonicalizeGenreTaxonomyArtifact(reversed),
      canonicalizeGenreTaxonomyArtifact(artifact()),
    );
  });

  it("uses locale-independent Unicode code-unit ordering for portable exports", () => {
    const canonical = canonicalizeGenreTaxonomyArtifact(
      artifact({
        categories: [
          { id: "ämbient", label: "Ambient", parentId: null },
          { id: "zeta", label: "Zeta", parentId: null },
        ],
        mappings: [
          { sourceTag: "ämbient", action: "keep", targetCategoryId: "ämbient" },
          { sourceTag: "zeta", action: "keep", targetCategoryId: "zeta" },
        ],
      }),
    );

    assert.deepEqual(
      canonical.categories.map((category) => category.id),
      ["zeta", "ämbient"],
    );
    assert.deepEqual(
      canonical.mappings.map((mapping) => mapping.sourceTag),
      ["zeta", "ämbient"],
    );
  });
});
