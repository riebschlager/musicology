import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { IngestIssueCode, SupportedSourceType } from "../../../src/importers/contracts.ts";
import {
  classifyLastfmRecord,
  fingerprintLastfmScrobble,
  fingerprintLastfmScrobbleOverlap,
  LASTFM_OVERLAP_FINGERPRINT_VERSION,
  LASTFM_SOURCE_FINGERPRINT_VERSION,
  LastfmExportDiscovery,
  LastfmFileBoundaryError,
  LastfmRecordRejectionReason,
  parseLastfmExport,
} from "../../../src/importers/lastfm-export/index.ts";
import { isSha256 } from "../../../src/importers/hashing.ts";
import { buildLastfmScrobbleFixture } from "../../fixtures/lastfm.ts";

describe("Last.fm export discovery", () => {
  it("discovers only explicit regular JSON files in the dedicated Last.fm directory", () => {
    const inputs = mkdtempSync(path.join(tmpdir(), "musicology-lastfm-discovery-"));
    const outside = mkdtempSync(path.join(tmpdir(), "musicology-lastfm-outside-"));
    const lastfmDirectory = path.join(inputs, "lastfm");
    mkdirSync(lastfmDirectory);

    try {
      const first = path.join(lastfmDirectory, "history.json");
      const second = path.join(lastfmDirectory, "history-2.json");
      const wrongExtension = path.join(lastfmDirectory, "history.csv");
      const nestedDirectory = path.join(lastfmDirectory, "nested");
      const elsewhere = path.join(inputs, "history.json");
      const outsideFile = path.join(outside, "outside.json");
      for (const file of [first, second, wrongExtension, elsewhere, outsideFile]) {
        writeFileSync(file, "[]\n", "utf8");
      }
      mkdirSync(nestedDirectory);
      const nested = path.join(nestedDirectory, "history.json");
      writeFileSync(nested, "[]\n", "utf8");
      const symlink = path.join(lastfmDirectory, "linked.json");
      symlinkSync(outsideFile, symlink);

      const discovery = new LastfmExportDiscovery(inputs);
      assert.deepEqual(
        discovery.discover([
          second,
          wrongExtension,
          nested,
          elsewhere,
          outsideFile,
          symlink,
          first,
          first,
        ]),
        [
          {
            absolutePath: second,
            relativePath: "lastfm/history-2.json",
            sourceType: SupportedSourceType.LastfmExport,
          },
          {
            absolutePath: first,
            relativePath: "lastfm/history.json",
            sourceType: SupportedSourceType.LastfmExport,
          },
        ],
      );
    } finally {
      rmSync(inputs, { recursive: true });
      rmSync(outside, { recursive: true });
    }
  });
});

describe("Last.fm record boundary", () => {
  it("projects a valid scrobble, normalizes its millisecond timestamp, and fingerprints it", () => {
    const source = buildLastfmScrobbleFixture();
    const result = classifyLastfmRecord(source);

    assert.equal(result.kind, "scrobble");
    if (result.kind === "scrobble") {
      assert.deepEqual(result.record, {
        albumName: source.album_name,
        artistMusicbrainzId: source.artist_musicbrainz_id,
        artistName: source.artist_name,
        loved: source.loved,
        recordingMusicbrainzId: source.recording_musicbrainz_id,
        releaseMusicbrainzId: source.release_musicbrainz_id,
        scrobbledAtEpochMs: source.timestamp,
        trackName: source.track_name,
      });
      assert.equal(isSha256(result.overlapFingerprintSha256), true);
      assert.equal(isSha256(result.sourceFingerprintSha256), true);
      assert.equal(
        result.overlapFingerprintSha256,
        fingerprintLastfmScrobbleOverlap(result.record),
      );
      assert.equal(result.sourceFingerprintSha256, fingerprintLastfmScrobble(result.record));
    }
  });

  it("tolerates absent, null, and empty optional album and identifier values", () => {
    const requiredOnly = classifyLastfmRecord({
      timestamp: 1_767_322_858_678,
      artist_name: "The Synthetic Signals",
      track_name: "Clockwork Garden",
    });
    const emptyOptional = classifyLastfmRecord(
      buildLastfmScrobbleFixture({
        album_name: "   ",
        artist_musicbrainz_id: "",
        release_musicbrainz_id: null,
        recording_musicbrainz_id: "",
        loved: null,
      }),
    );

    for (const result of [requiredOnly, emptyOptional]) {
      assert.equal(result.kind, "scrobble");
      if (result.kind === "scrobble") {
        assert.equal(result.record.albumName, null);
        assert.equal(result.record.artistMusicbrainzId, null);
        assert.equal(result.record.releaseMusicbrainzId, null);
        assert.equal(result.record.recordingMusicbrainzId, null);
        assert.equal(result.record.loved, null);
      }
    }
  });

  it("preserves approved Unicode display text exactly", () => {
    const artistName = "  Beyoncé de Prueba  ";
    const albumName = "Señales синтетические";
    const trackName = "雪のテスト — Café 🎧";
    const result = classifyLastfmRecord(
      buildLastfmScrobbleFixture({
        artist_name: artistName,
        album_name: albumName,
        track_name: trackName,
      }),
    );

    assert.equal(result.kind, "scrobble");
    if (result.kind === "scrobble") {
      assert.equal(result.record.artistName, artistName);
      assert.equal(result.record.albumName, albumName);
      assert.equal(result.record.trackName, trackName);
    }
  });

  it("rejects malformed timestamps and empty required display text with safe reasons", () => {
    for (const [value, reason] of [
      [
        buildLastfmScrobbleFixture({ timestamp: "not-a-timestamp" }),
        LastfmRecordRejectionReason.InvalidTimestamp,
      ],
      [buildLastfmScrobbleFixture({ timestamp: -1 }), LastfmRecordRejectionReason.InvalidTimestamp],
      [
        buildLastfmScrobbleFixture({ timestamp: 1.5 }),
        LastfmRecordRejectionReason.InvalidTimestamp,
      ],
      [
        buildLastfmScrobbleFixture({ timestamp: Number.MAX_SAFE_INTEGER + 1 }),
        LastfmRecordRejectionReason.InvalidTimestamp,
      ],
      [
        buildLastfmScrobbleFixture({ artist_name: "   " }),
        LastfmRecordRejectionReason.InvalidRequiredText,
      ],
      [
        buildLastfmScrobbleFixture({ track_name: "" }),
        LastfmRecordRejectionReason.InvalidRequiredText,
      ],
    ] as const) {
      assert.deepEqual(classifyLastfmRecord(value), {
        kind: "malformed",
        code: IngestIssueCode.RejectedRecord,
        reason,
      });
    }
  });

  it("rejects invalid required and optional field types", () => {
    for (const value of [
      null,
      buildLastfmScrobbleFixture({ artist_name: null }),
      buildLastfmScrobbleFixture({ track_name: 42 }),
      buildLastfmScrobbleFixture({ album_name: false }),
      buildLastfmScrobbleFixture({ recording_musicbrainz_id: 42 }),
      buildLastfmScrobbleFixture({ loved: "false" }),
    ]) {
      const result = classifyLastfmRecord(value);
      assert.equal(result.kind, "malformed");
      if (result.kind === "malformed") {
        assert.ok(
          result.reason === LastfmRecordRejectionReason.InvalidRecord ||
            result.reason === LastfmRecordRejectionReason.InvalidFieldType,
        );
      }
    }
  });

  it("separates deterministic source identity from export/API overlap identity", () => {
    const base = classifyLastfmRecord(buildLastfmScrobbleFixture());
    const metadataVariant = classifyLastfmRecord(
      buildLastfmScrobbleFixture({
        album_name: null,
        artist_musicbrainz_id: null,
        release_musicbrainz_id: null,
        recording_musicbrainz_id: null,
        loved: true,
      }),
    );
    const strongIdentifierConflict = classifyLastfmRecord(
      buildLastfmScrobbleFixture({
        recording_musicbrainz_id: "00000000-0000-4000-8000-000000000099",
      }),
    );
    const eventVariants = [
      classifyLastfmRecord(buildLastfmScrobbleFixture({ timestamp: 1_767_322_858_679 })),
      classifyLastfmRecord(buildLastfmScrobbleFixture({ artist_name: "Another Artist" })),
      classifyLastfmRecord(buildLastfmScrobbleFixture({ track_name: "Another Track" })),
    ];

    assert.equal(LASTFM_OVERLAP_FINGERPRINT_VERSION, "lastfm-overlap-v1");
    assert.equal(LASTFM_SOURCE_FINGERPRINT_VERSION, "lastfm-source-v1");
    assert.equal(base.kind, "scrobble");
    assert.equal(metadataVariant.kind, "scrobble");
    assert.equal(strongIdentifierConflict.kind, "scrobble");
    if (
      base.kind === "scrobble" &&
      metadataVariant.kind === "scrobble" &&
      strongIdentifierConflict.kind === "scrobble"
    ) {
      assert.notEqual(base.sourceFingerprintSha256, metadataVariant.sourceFingerprintSha256);
      assert.equal(base.overlapFingerprintSha256, metadataVariant.overlapFingerprintSha256);
      assert.notEqual(
        base.sourceFingerprintSha256,
        strongIdentifierConflict.sourceFingerprintSha256,
      );
      assert.equal(
        base.overlapFingerprintSha256,
        strongIdentifierConflict.overlapFingerprintSha256,
      );
      const repeat = classifyLastfmRecord(buildLastfmScrobbleFixture());
      assert.equal(repeat.kind, "scrobble");
      if (repeat.kind === "scrobble") {
        assert.equal(base.sourceFingerprintSha256, repeat.sourceFingerprintSha256);
        assert.equal(base.overlapFingerprintSha256, repeat.overlapFingerprintSha256);
      }
      for (const variant of eventVariants) {
        assert.equal(variant.kind, "scrobble");
        if (variant.kind === "scrobble") {
          assert.notEqual(base.sourceFingerprintSha256, variant.sourceFingerprintSha256);
          assert.notEqual(base.overlapFingerprintSha256, variant.overlapFingerprintSha256);
        }
      }
    }
  });

  it("returns only allowlisted fields and never exposes unknown source values", () => {
    const privateMarker = "synthetic-sensitive-marker";
    const result = classifyLastfmRecord({
      ...buildLastfmScrobbleFixture(),
      unknown_private_field: privateMarker,
    });
    assert.equal(JSON.stringify(result).includes(privateMarker), false);
    assert.deepEqual(result.kind === "scrobble" ? Object.keys(result.record).sort() : [], [
      "albumName",
      "artistMusicbrainzId",
      "artistName",
      "loved",
      "recordingMusicbrainzId",
      "releaseMusicbrainzId",
      "scrobbledAtEpochMs",
      "trackName",
    ]);
  });
});

describe("Last.fm file boundary", () => {
  it("requires an array and classifies every record with a stable zero-based ordinal", () => {
    const parsed = parseLastfmExport(
      JSON.stringify([
        buildLastfmScrobbleFixture(),
        buildLastfmScrobbleFixture({ album_name: null }),
        buildLastfmScrobbleFixture({ timestamp: "invalid" }),
      ]),
    );

    assert.deepEqual(
      parsed.map(({ kind, ordinal }) => ({ kind, ordinal })),
      [
        { kind: "scrobble", ordinal: 0 },
        { kind: "scrobble", ordinal: 1 },
        { kind: "malformed", ordinal: 2 },
      ],
    );
  });

  it("rejects invalid JSON and non-array JSON with one fixed safe file error", () => {
    const privateMarker = "synthetic-sensitive-marker";
    for (const contents of [
      `[{"unknown_private_field":"${privateMarker}"}`,
      "{}",
      "null",
      '"array"',
    ]) {
      assert.throws(
        () => parseLastfmExport(contents),
        (error: unknown) => {
          assert.ok(error instanceof LastfmFileBoundaryError);
          assert.equal(error.code, IngestIssueCode.MalformedFile);
          assert.equal(error.message, "Source file is malformed");
          assert.equal(error.message.includes(privateMarker), false);
          assert.equal(error.cause, undefined);
          return true;
        },
      );
    }
  });
});
