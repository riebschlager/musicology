import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GENRE_EVIDENCE_CONTRACT_VERSION,
  MUSICBRAINZ_ATTRIBUTION,
  MUSICBRAINZ_LICENSE,
  MUSICBRAINZ_PROVIDER,
  MUSICBRAINZ_RESPONSE_SCHEMA_VERSION,
  type GenreEnrichmentSnapshot,
  validateGenreEnrichmentSnapshot,
} from "../../../src/genre/evidence-contract.ts";

function snapshot(overrides: Partial<GenreEnrichmentSnapshot> = {}): GenreEnrichmentSnapshot {
  return {
    artistId: 1,
    provider: MUSICBRAINZ_PROVIDER,
    providerEntityId: "c0ffee00-cafe-4000-8000-000000000001",
    providerResponseSchemaVersion: MUSICBRAINZ_RESPONSE_SCHEMA_VERSION,
    contractVersion: GENRE_EVIDENCE_CONTRACT_VERSION,
    providerLicense: MUSICBRAINZ_LICENSE,
    providerAttribution: MUSICBRAINZ_ATTRIBUTION,
    fetchedAtEpochMs: 1_700_000_000_000,
    cacheState: "success",
    outcome: "success",
    errorCode: null,
    supersedesSnapshotId: null,
    rawTags: [
      {
        rawTagName: "Dream Pop",
        normalizedRawTag: "dream pop",
        rawWeight: 12,
        confidence: null,
        isRecognizedGenre: true,
      },
    ],
    ...overrides,
  };
}

describe("genre enrichment evidence contract", () => {
  it("preserves provider, freshness, raw weight, and nullable confidence", () => {
    assert.doesNotThrow(() => validateGenreEnrichmentSnapshot(snapshot()));
  });

  it("keeps negative and failed cache outcomes distinct from successful raw evidence", () => {
    assert.doesNotThrow(() =>
      validateGenreEnrichmentSnapshot(
        snapshot({ cacheState: "negative", outcome: "no_tags", rawTags: [] }),
      ),
    );
    assert.doesNotThrow(() =>
      validateGenreEnrichmentSnapshot(
        snapshot({
          cacheState: "negative",
          outcome: "not_found",
          errorCode: "not_found",
          rawTags: [],
        }),
      ),
    );
    assert.doesNotThrow(() =>
      validateGenreEnrichmentSnapshot(
        snapshot({
          cacheState: "failure",
          outcome: "temporary_failure",
          errorCode: "timeout",
          rawTags: [],
        }),
      ),
    );
    assert.throws(() =>
      validateGenreEnrichmentSnapshot(
        snapshot({ cacheState: "failure", outcome: "temporary_failure" }),
      ),
    );
  });

  it("rejects empty success results, duplicate raw tags, and non-success raw evidence", () => {
    assert.throws(() => validateGenreEnrichmentSnapshot(snapshot({ rawTags: [] })));
    assert.throws(() =>
      validateGenreEnrichmentSnapshot(
        snapshot({
          rawTags: [
            ...snapshot().rawTags,
            {
              rawTagName: "dream-pop",
              normalizedRawTag: "dream pop",
              rawWeight: 1,
              confidence: null,
              isRecognizedGenre: false,
            },
          ],
        }),
      ),
    );
    assert.throws(() =>
      validateGenreEnrichmentSnapshot(
        snapshot({ cacheState: "negative", outcome: "no_tags", rawTags: snapshot().rawTags }),
      ),
    );
  });
});
