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

  it("admits track display detail only through the manual story allowlist", () => {
    const candidates = [
      {
        artistDisplayName: "Synthetic Artist",
        selectionKey: "private-selection-a",
        trackDisplayName: "Selected Synthetic Track",
      },
      {
        artistDisplayName: "Another Synthetic Artist",
        selectionKey: "private-selection-b",
        trackDisplayName: "Unselected Synthetic Track",
      },
    ];

    assert.deepEqual(
      selectEditorialTrackDetails(candidates, [
        {
          selectionKey: "private-selection-a",
          storySlug: "selected-return",
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
    assert.throws(
      () =>
        selectEditorialTrackDetails(candidates, [
          {
            selectionKey: "missing-selection",
            storySlug: "missing-story",
            trackSlug: "missing-track",
          },
        ]),
      /does not resolve to one candidate/u,
    );
  });

  it("never echoes private selection keys in policy errors", () => {
    const privateKey = "private-artist-id-123";
    const operations = [
      () =>
        selectEditorialTrackDetails(
          [],
          [{ selectionKey: privateKey, storySlug: "missing-story", trackSlug: "missing-track" }],
        ),
      () =>
        selectEditorialTrackDetails(
          [
            {
              artistDisplayName: "Synthetic Artist",
              selectionKey: privateKey,
              trackDisplayName: "Synthetic Track",
            },
          ],
          [
            { selectionKey: privateKey, storySlug: "story-one", trackSlug: "track-one" },
            { selectionKey: privateKey, storySlug: "story-two", trackSlug: "track-two" },
          ],
        ),
      () =>
        selectEditorialTrackDetails(
          [
            {
              artistDisplayName: "Synthetic Artist",
              selectionKey: privateKey,
              trackDisplayName: "Synthetic Track",
            },
            {
              artistDisplayName: "Synthetic Artist Two",
              selectionKey: privateKey,
              trackDisplayName: "Synthetic Track Two",
            },
          ],
          [],
        ),
    ];
    for (const operation of operations) {
      let message = "";
      try {
        operation();
      } catch (error) {
        assert.ok(error instanceof PublicationPolicyError);
        message = error.message;
      }
      assert.notEqual(message, "");
      assert.equal(message.includes(privateKey), false);
    }
  });
});
