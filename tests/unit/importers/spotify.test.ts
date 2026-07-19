import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  classifySpotifyRecord,
  parseSpotifyAudioExport,
  SpotifyAudioExportDiscovery,
  SpotifyExcludedContent,
  SpotifyFileBoundaryError,
  SpotifyRecordRejectionReason,
} from "../../../src/importers/spotify/index.ts";
import { IngestIssueCode, SupportedSourceType } from "../../../src/importers/contracts.ts";
import { buildSpotifyEpisodeFixture, buildSpotifyTrackFixture } from "../../fixtures/spotify.ts";

describe("Spotify audio export discovery", () => {
  it("discovers only explicit regular audio-history files inside the evidence root", () => {
    const inputs = mkdtempSync(path.join(tmpdir(), "musicology-spotify-discovery-"));
    const outside = mkdtempSync(path.join(tmpdir(), "musicology-spotify-outside-"));
    const spotifyDirectory = path.join(inputs, "spotify");
    mkdirSync(spotifyDirectory);
    const writeFixture = (filename: string): string => {
      const fixturePath = path.join(spotifyDirectory, filename);
      writeFileSync(fixturePath, "[]\n", "utf8");
      return fixturePath;
    };

    try {
      const first = writeFixture("Streaming_History_Audio_2011-2013_0.json");
      const second = writeFixture("Streaming_History_Audio_2026_1.json");
      const video = writeFixture("Streaming_History_Video_2026_0.json");
      const arbitraryJson = writeFixture("listening.json");
      const directory = path.join(inputs, "spotify", "Streaming_History_Audio_2026_2.json");
      mkdirSync(directory);
      const symlink = path.join(inputs, "spotify", "Streaming_History_Audio_2026_3.json");
      symlinkSync(first, symlink);
      const outsideFile = path.join(outside, "Streaming_History_Audio_2026_4.json");
      writeFileSync(outsideFile, "[]\n", "utf8");
      const outsideDirectorySymlink = path.join(inputs, "linked-outside");
      symlinkSync(outside, outsideDirectorySymlink);

      const discovery = new SpotifyAudioExportDiscovery(inputs);
      assert.deepEqual(
        discovery.discover([
          second,
          video,
          arbitraryJson,
          directory,
          symlink,
          first,
          first,
          path.join(inputs, "..", "outside", "Streaming_History_Audio_2026_4.json"),
          path.join(outsideDirectorySymlink, "Streaming_History_Audio_2026_4.json"),
        ]),
        [
          {
            absolutePath: first,
            relativePath: "spotify/Streaming_History_Audio_2011-2013_0.json",
            sourceType: SupportedSourceType.SpotifyExport,
          },
          {
            absolutePath: second,
            relativePath: "spotify/Streaming_History_Audio_2026_1.json",
            sourceType: SupportedSourceType.SpotifyExport,
          },
        ],
      );
    } finally {
      rmSync(inputs, { recursive: true });
      rmSync(outside, { recursive: true });
    }
  });
});

describe("Spotify record boundary", () => {
  it("projects a valid track and derives its UTC start from the observed stop and duration", () => {
    const source = buildSpotifyTrackFixture();
    const result = classifySpotifyRecord(source);

    assert.deepEqual(result, {
      kind: "track",
      record: {
        albumName: source.master_metadata_album_album_name,
        artistName: source.master_metadata_album_artist_name,
        msPlayed: source.ms_played,
        offline: source.offline,
        offlineTimestamp: source.offline_timestamp,
        reasonEnd: source.reason_end,
        reasonStart: source.reason_start,
        shuffle: source.shuffle,
        skipped: source.skipped,
        spotifyTrackUri: source.spotify_track_uri,
        startedAtEpochMs: Date.parse(source.ts) - source.ms_played,
        stoppedAtEpochMs: Date.parse(source.ts),
        trackName: source.master_metadata_track_name,
      },
    });
  });

  it("retains zero-duration and short track evidence at exact arithmetic boundaries", () => {
    for (const msPlayed of [0, 1, 29_999]) {
      const result = classifySpotifyRecord(buildSpotifyTrackFixture({ ms_played: msPlayed }));
      assert.equal(result.kind, "track");
      if (result.kind === "track") {
        assert.equal(result.record.msPlayed, msPlayed);
        assert.equal(result.record.startedAtEpochMs, result.record.stoppedAtEpochMs - msPlayed);
      }
    }
  });

  it("preserves approved Unicode display text exactly", () => {
    const artistName = "Beyoncé de Prueba";
    const albumName = "Señales синтетические";
    const trackName = "雪のテスト — Café 🎧";
    const result = classifySpotifyRecord(
      buildSpotifyTrackFixture({
        master_metadata_album_artist_name: artistName,
        master_metadata_album_album_name: albumName,
        master_metadata_track_name: trackName,
      }),
    );

    assert.equal(result.kind, "track");
    if (result.kind === "track") {
      assert.equal(result.record.artistName, artistName);
      assert.equal(result.record.albumName, albumName);
      assert.equal(result.record.trackName, trackName);
    }
  });

  it("classifies episodes and audiobooks as excluded non-music", () => {
    const episode = classifySpotifyRecord(buildSpotifyEpisodeFixture());
    const audiobook = classifySpotifyRecord({
      ...buildSpotifyTrackFixture({
        master_metadata_album_album_name: null,
        master_metadata_album_artist_name: null,
        master_metadata_track_name: null,
        spotify_track_uri: null,
      }),
      audiobook_chapter_title: "Synthetic Chapter One",
      audiobook_chapter_uri: "spotify:episode:synthetic-chapter-1",
      audiobook_title: "A Synthetic Audiobook",
      audiobook_uri: "spotify:show:synthetic-audiobook",
    });

    for (const result of [episode, audiobook]) {
      assert.deepEqual(result, {
        kind: "excluded",
        code: IngestIssueCode.ExcludedNonMusicRecord,
        category: SpotifyExcludedContent.EpisodeOrAudiobook,
      });
    }
  });

  it("classifies a record with no track URI or non-music marker as video or unsupported", () => {
    assert.deepEqual(classifySpotifyRecord(buildSpotifyTrackFixture({ spotify_track_uri: null })), {
      kind: "excluded",
      code: IngestIssueCode.ExcludedNonMusicRecord,
      category: SpotifyExcludedContent.VideoOrUnsupported,
    });
  });

  it("rejects malformed records with stable safe reasons", () => {
    const cases = [
      {
        reason: SpotifyRecordRejectionReason.InvalidRecord,
        value: null,
      },
      {
        reason: SpotifyRecordRejectionReason.InvalidDuration,
        value: buildSpotifyTrackFixture({ ms_played: "not-a-number" }),
      },
      {
        reason: SpotifyRecordRejectionReason.InvalidDuration,
        value: buildSpotifyTrackFixture({ ms_played: -1 }),
      },
      {
        reason: SpotifyRecordRejectionReason.InvalidTrackUri,
        value: buildSpotifyTrackFixture({ spotify_track_uri: "https://example.invalid/track" }),
      },
      ...[
        "spotify:track: ",
        "spotify:track:not/valid",
        "spotify:track:short",
        "spotify:track:00000000000000000000000",
      ].map((spotify_track_uri) => ({
        reason: SpotifyRecordRejectionReason.InvalidTrackUri,
        value: buildSpotifyTrackFixture({ spotify_track_uri }),
      })),
      {
        reason: SpotifyRecordRejectionReason.InvalidTrackMetadata,
        value: buildSpotifyTrackFixture({ master_metadata_track_name: "   " }),
      },
      {
        reason: SpotifyRecordRejectionReason.InvalidFieldType,
        value: buildSpotifyTrackFixture({ skipped: "false" }),
      },
      {
        reason: SpotifyRecordRejectionReason.InvalidFieldType,
        value: buildSpotifyEpisodeFixture({ shuffle: null }),
      },
    ] as const;

    for (const fixtureCase of cases) {
      assert.deepEqual(classifySpotifyRecord(fixtureCase.value), {
        kind: "malformed",
        code: IngestIssueCode.RejectedRecord,
        reason: fixtureCase.reason,
      });
    }
  });

  it("rejects ambiguous, impossible, and unsafe timestamps", () => {
    for (const [ts, reason, msPlayed] of [
      ["2026-01-02T03:04:05", SpotifyRecordRejectionReason.InvalidTimestamp, 1],
      ["2026-02-30T03:04:05Z", SpotifyRecordRejectionReason.InvalidTimestamp, 1],
      ["not-a-timestamp", SpotifyRecordRejectionReason.InvalidTimestamp, 1],
      ["1970-01-01T00:00:00.001Z", SpotifyRecordRejectionReason.InvalidTimeArithmetic, 2],
    ] as const) {
      assert.deepEqual(
        classifySpotifyRecord(buildSpotifyTrackFixture({ ts, ms_played: msPlayed })),
        {
          kind: "malformed",
          code: IngestIssueCode.RejectedRecord,
          reason,
        },
      );
    }
  });

  it("returns only allowlisted fields and never includes excluded source values in diagnostics", () => {
    const privateMarker = "synthetic-sensitive-marker";
    const value = {
      ...buildSpotifyTrackFixture(),
      ["ip_" + "addr"]: privateMarker,
      ["plat" + "form"]: privateMarker,
      ["user" + "name"]: privateMarker,
    };
    const accepted = classifySpotifyRecord(value);
    assert.equal(JSON.stringify(accepted).includes(privateMarker), false);
    assert.deepEqual(accepted.kind === "track" ? Object.keys(accepted.record).sort() : [], [
      "albumName",
      "artistName",
      "msPlayed",
      "offline",
      "offlineTimestamp",
      "reasonEnd",
      "reasonStart",
      "shuffle",
      "skipped",
      "spotifyTrackUri",
      "startedAtEpochMs",
      "stoppedAtEpochMs",
      "trackName",
    ]);

    const malformed = classifySpotifyRecord({ ...value, ts: privateMarker });
    assert.equal(JSON.stringify(malformed).includes(privateMarker), false);

    const malformedFile = `[{"${"user" + "name"}":"${privateMarker}"}`;
    assert.throws(
      () => parseSpotifyAudioExport(malformedFile),
      (error: unknown) => {
        assert.ok(error instanceof SpotifyFileBoundaryError);
        assert.equal(error.code, IngestIssueCode.MalformedFile);
        assert.equal(error.message.includes(privateMarker), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });
});

describe("Spotify file boundary", () => {
  it("requires an array and classifies every record with a stable zero-based ordinal", () => {
    const parsed = parseSpotifyAudioExport(
      JSON.stringify([
        buildSpotifyTrackFixture(),
        buildSpotifyEpisodeFixture(),
        buildSpotifyTrackFixture({ ms_played: "invalid" }),
      ]),
    );

    assert.deepEqual(
      parsed.map(({ kind, ordinal }) => ({ kind, ordinal })),
      [
        { kind: "track", ordinal: 0 },
        { kind: "excluded", ordinal: 1 },
        { kind: "malformed", ordinal: 2 },
      ],
    );
  });

  it("rejects invalid JSON and non-array JSON with one fixed safe file error", () => {
    for (const contents of ["not json", "{}", "null", '"array"']) {
      assert.throws(
        () => parseSpotifyAudioExport(contents),
        (error: unknown) =>
          error instanceof SpotifyFileBoundaryError &&
          error.code === IngestIssueCode.MalformedFile &&
          error.message === "Source file is malformed",
      );
    }
  });
});
