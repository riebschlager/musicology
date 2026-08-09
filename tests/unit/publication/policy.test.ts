import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PUBLIC_SELECTION_POLICY,
  PublicationPolicyError,
  isPublicArtistEligible,
  reduceAnalyticalTimestampToMonth,
  reduceOperationalTimestampToDate,
  selectEditorialTrackDetails,
  selectEligiblePublicArtists,
} from "../../../src/publication/policy.ts";

describe("public selection policy", () => {
  it("reduces analytical instants to months and operational instants to dates", () => {
    assert.equal(
      reduceAnalyticalTimestampToMonth("2026-08-09T23:59:59.999Z", "America/Chicago"),
      "2026-08",
    );
    assert.equal(
      reduceAnalyticalTimestampToMonth("2020-03-01T01:00:00.000Z", "America/Chicago"),
      "2020-02",
    );
    assert.equal(
      reduceAnalyticalTimestampToMonth("2020-03-01T01:00:00.000Z", "Asia/Tokyo"),
      "2020-03",
    );
    assert.equal(reduceOperationalTimestampToDate("2026-08-09T23:59:59.999Z"), "2026-08-09");
    assert.throws(
      () => reduceAnalyticalTimestampToMonth("2026-08-09", "America/Chicago"),
      PublicationPolicyError,
    );
    assert.throws(
      () => reduceAnalyticalTimestampToMonth("2026-08-09T00:00:00.000Z", "Not/A_Zone"),
      /valid IANA timezone/u,
    );
  });

  it("enforces both artist significance thresholds at their exact boundaries", () => {
    const boundary = {
      displayName: "Synthetic Boundary Artist",
      intervals: [
        {
          playCount: PUBLIC_SELECTION_POLICY.artistEligibility.minimumQualifyingIntervalPlayCount,
          strength: PUBLIC_SELECTION_POLICY.artistEligibility.minimumPeakStrength,
        },
      ],
      slug: "synthetic-boundary-artist",
    };
    assert.equal(isPublicArtistEligible(boundary), true);
    assert.equal(
      isPublicArtistEligible({
        ...boundary,
        intervals: [
          {
            playCount:
              PUBLIC_SELECTION_POLICY.artistEligibility.minimumQualifyingIntervalPlayCount - 1,
            strength: PUBLIC_SELECTION_POLICY.artistEligibility.minimumPeakStrength,
          },
        ],
      }),
      false,
    );
    assert.equal(
      isPublicArtistEligible({
        ...boundary,
        intervals: [
          {
            playCount: PUBLIC_SELECTION_POLICY.artistEligibility.minimumQualifyingIntervalPlayCount,
            strength: PUBLIC_SELECTION_POLICY.artistEligibility.minimumPeakStrength - 0.01,
          },
        ],
      }),
      false,
    );
  });

  it("suppresses the long tail after deterministic aggregate ranking", () => {
    const candidates = Array.from(
      { length: PUBLIC_SELECTION_POLICY.artistEligibility.maximumArtists + 2 },
      (_, index) => ({
        displayName: `Synthetic Artist ${index}`,
        intervals: [{ playCount: 24 + index, strength: 0.75 }],
        slug: `synthetic-artist-${index}`,
      }),
    );
    const selected = selectEligiblePublicArtists(candidates);

    assert.equal(selected.length, PUBLIC_SELECTION_POLICY.artistEligibility.maximumArtists);
    assert.equal(selected[0]?.slug, "synthetic-artist-201");
    assert.equal(selected.at(-1)?.slug, "synthetic-artist-2");
    assert.equal(
      selected.some((candidate) => candidate.slug === "synthetic-artist-0"),
      false,
    );
    assert.equal(
      selected.some((candidate) => candidate.slug === "synthetic-artist-1"),
      false,
    );
  });

  it("admits wholly manual track identity only through the reviewed story allowlist", () => {
    assert.deepEqual(
      selectEditorialTrackDetails([
        {
          artistDisplayName: "Synthetic Artist",
          storySlug: "selected-return",
          trackDisplayName: "Selected Synthetic Track",
          trackSlug: "selected-synthetic-track",
        },
      ]),
      [
        {
          artistDisplayName: "Synthetic Artist",
          slug: "selected-synthetic-track",
          storySlug: "selected-return",
          trackDisplayName: "Selected Synthetic Track",
        },
      ],
    );
  });

  it("rejects duplicate manual track identities, story assignments, and public slugs", () => {
    const operations = [
      () =>
        selectEditorialTrackDetails([
          {
            artistDisplayName: "Synthetic Artist",
            storySlug: "story-one",
            trackDisplayName: "Synthetic Track",
            trackSlug: "track-one",
          },
          {
            artistDisplayName: "Synthetic Artist",
            storySlug: "story-two",
            trackDisplayName: "Synthetic Track",
            trackSlug: "track-two",
          },
        ]),
      () =>
        selectEditorialTrackDetails([
          {
            artistDisplayName: "Synthetic Artist",
            storySlug: "story-one",
            trackDisplayName: "Synthetic Track",
            trackSlug: "track-one",
          },
          {
            artistDisplayName: "Synthetic Artist Two",
            storySlug: "story-one",
            trackDisplayName: "Synthetic Track Two",
            trackSlug: "track-two",
          },
        ]),
      () =>
        selectEditorialTrackDetails([
          {
            artistDisplayName: "Synthetic Artist",
            storySlug: "story-one",
            trackDisplayName: "Synthetic Track",
            trackSlug: "same-track",
          },
          {
            artistDisplayName: "Synthetic Artist Two",
            storySlug: "story-two",
            trackDisplayName: "Synthetic Track Two",
            trackSlug: "same-track",
          },
        ]),
    ];
    for (const operation of operations) {
      assert.throws(operation, PublicationPolicyError);
    }
  });

  it("rejects empty manual display identity without consulting private candidates", () => {
    assert.throws(
      () =>
        selectEditorialTrackDetails([
          {
            artistDisplayName: "",
            storySlug: "story-one",
            trackDisplayName: "Synthetic Track",
            trackSlug: "synthetic-track",
          },
        ]),
      /artist display name/u,
    );
  });
});
