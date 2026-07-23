import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const decisionPath = new URL(
  "../../docs/decisions/phase-5-genre-provider-taxonomy.md",
  import.meta.url,
);

function readDecision(): string {
  return readFileSync(decisionPath, "utf8");
}

describe("P5-01 genre provider and taxonomy decision", () => {
  it("selects a bounded provider and hybrid evidence strategy", () => {
    const decision = readDecision();

    assert.match(
      decision,
      /Use the MusicBrainz Web Service as the only initial genre-evidence provider\./,
    );
    assert.match(decision, /Use a \*\*hybrid taxonomy\*\*/);
    assert.match(decision, /No name search, Spotify lookup, or inferred provider identity/);
    assert.match(decision, /raw tag and its provider vote count as evidence/);
  });

  it("keeps the provider assessment reproducible, aggregate-only, and privacy-safe", () => {
    const decision = readDecision();

    assert.match(decision, /WITH current_artist_events AS/);
    assert.match(decision, /top_200_by_current_event_count_then_artist_id/);
    assert.match(decision, /identifier\.is_strong = 1/);
    assert.match(decision, /lookup only from its strong,\s+exact MBID/i);
    assert.match(
      decision,
      /https:\/\/musicbrainz\.org\/ws\/2\/artist\/\{musicbrainz_artist_id\}\?fmt=json&inc=genres\+tags/,
    );
    assert.match(
      decision,
      /User-Agent`: `musicology\/0\.0\.0 \(https:\/\/github\.com\/riebschlager\/musicology\)`/,
    );
    assert.match(decision, /adds no environment variable or secret configuration/);
    assert.match(
      decision,
      /only aggregate counts:\s*no artist\s+names, identifiers, source rows, or listening timestamps/i,
    );
    assert.match(decision, /no credential, token, account name, or API\s+key/i);
    assert.doesNotMatch(decision, /LASTFM_API_KEY=/);
    assert.doesNotMatch(decision, /MUSICOLOGY_[A-Z0-9_]+=/);
  });

  it("records alternatives, refresh policy, licensing, and future contract boundaries", () => {
    const decision = readDecision();

    for (const requiredText of [
      "Last.fm artist top tags",
      "Spotify Web API artist metadata",
      "Discogs API",
      "180-day default refresh age",
      "CC BY-NC-SA",
      "P5-02 evidence contract",
    ]) {
      assert.ok(decision.includes(requiredText), `missing decision content: ${requiredText}`);
    }
  });
});
