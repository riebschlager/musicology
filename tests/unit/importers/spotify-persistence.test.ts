import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifySpotifyRecord,
  fingerprintSpotifyTrackRecord,
  SPOTIFY_SOURCE_FINGERPRINT_VERSION,
} from "../../../src/importers/spotify/index.ts";
import { buildSpotifyTrackFixture } from "../../fixtures/spotify.ts";

function projectedTrack() {
  const classification = classifySpotifyRecord(buildSpotifyTrackFixture());
  assert.equal(classification.kind, "track");
  if (classification.kind !== "track") {
    throw new Error("Synthetic fixture must classify as a track");
  }
  return classification.record;
}

describe("Spotify source fingerprints", () => {
  it("is deterministic for the complete projected record and independent of file location", () => {
    const record = projectedTrack();
    const first = fingerprintSpotifyTrackRecord(record);
    const second = fingerprintSpotifyTrackRecord({ ...record });

    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, second);
    assert.equal(SPOTIFY_SOURCE_FINGERPRINT_VERSION, "spotify-source-v1");
  });

  it("distinguishes changes to nullable, textual, boolean, duration, and time evidence", () => {
    const record = projectedTrack();
    const fingerprint = fingerprintSpotifyTrackRecord(record);
    const variants = [
      { ...record, albumName: null },
      { ...record, artistName: `${record.artistName}!` },
      { ...record, msPlayed: record.msPlayed + 1 },
      { ...record, offline: null },
      { ...record, offlineTimestamp: 1 },
      { ...record, reasonEnd: null },
      { ...record, reasonStart: null },
      { ...record, shuffle: !record.shuffle },
      { ...record, skipped: null },
      { ...record, spotifyTrackUri: "spotify:track:0000000000000000000099" },
      { ...record, startedAtEpochMs: record.startedAtEpochMs + 1 },
      { ...record, stoppedAtEpochMs: record.stoppedAtEpochMs + 1 },
      { ...record, trackName: `${record.trackName}!` },
    ];

    for (const variant of variants) {
      assert.notEqual(fingerprintSpotifyTrackRecord(variant), fingerprint);
    }
  });
});
