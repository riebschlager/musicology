import { IngestIssueCode, IngestIssueSummary } from "../contracts.ts";

const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const SPOTIFY_TRACK_URI_PATTERN = /^spotify:track:[A-Za-z0-9]{22}$/;

export const SpotifyExcludedContent = {
  EpisodeOrAudiobook: "episode_or_audiobook",
  VideoOrUnsupported: "video_or_unsupported",
} as const;

export type SpotifyExcludedContent =
  (typeof SpotifyExcludedContent)[keyof typeof SpotifyExcludedContent];

export const SpotifyRecordRejectionReason = {
  InvalidDuration: "invalid_duration",
  InvalidFieldType: "invalid_field_type",
  InvalidRecord: "invalid_record",
  InvalidTimeArithmetic: "invalid_time_arithmetic",
  InvalidTimestamp: "invalid_timestamp",
  InvalidTrackMetadata: "invalid_track_metadata",
  InvalidTrackUri: "invalid_track_uri",
} as const;

export type SpotifyRecordRejectionReason =
  (typeof SpotifyRecordRejectionReason)[keyof typeof SpotifyRecordRejectionReason];

/** The complete privacy-reviewed projection that may cross the Spotify boundary. */
export interface SpotifyTrackSourceRecord {
  readonly albumName: string | null;
  readonly artistName: string;
  readonly msPlayed: number;
  readonly offline: boolean | null;
  readonly offlineTimestamp: number | null;
  readonly reasonEnd: string | null;
  readonly reasonStart: string | null;
  readonly shuffle: boolean;
  readonly skipped: boolean | null;
  readonly spotifyTrackUri: string;
  readonly startedAtEpochMs: number;
  readonly stoppedAtEpochMs: number;
  readonly trackName: string;
}

export type SpotifyRecordClassification =
  | {
      readonly kind: "track";
      readonly record: SpotifyTrackSourceRecord;
    }
  | {
      readonly category: SpotifyExcludedContent;
      readonly code: typeof IngestIssueCode.ExcludedNonMusicRecord;
      readonly kind: "excluded";
    }
  | {
      readonly code: typeof IngestIssueCode.RejectedRecord;
      readonly kind: "malformed";
      readonly reason: SpotifyRecordRejectionReason;
    };

export type SpotifyClassifiedRecord = SpotifyRecordClassification & {
  readonly ordinal: number;
};

export class SpotifyFileBoundaryError extends Error {
  readonly code = IngestIssueCode.MalformedFile;
  readonly safeSummary = IngestIssueSummary[IngestIssueCode.MalformedFile];

  constructor() {
    super(IngestIssueSummary[IngestIssueCode.MalformedFile]);
    this.name = "SpotifyFileBoundaryError";
  }
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(reason: SpotifyRecordRejectionReason): SpotifyRecordClassification {
  return { kind: "malformed", code: IngestIssueCode.RejectedRecord, reason };
}

function nullableString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined {
  const value = record[key];
  return value === undefined || value === null || typeof value === "string"
    ? (value ?? null)
    : undefined;
}

function nullableBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean | null | undefined {
  const value = record[key];
  return value === undefined || value === null || typeof value === "boolean"
    ? (value ?? null)
    : undefined;
}

function nullableSafeNonNegativeInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function parseUtcTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "0").padEnd(3, "0"));
  const epochMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const instant = new Date(epochMs);

  if (
    !Number.isSafeInteger(epochMs) ||
    epochMs < 0 ||
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day ||
    instant.getUTCHours() !== hour ||
    instant.getUTCMinutes() !== minute ||
    instant.getUTCSeconds() !== second ||
    instant.getUTCMilliseconds() !== millisecond
  ) {
    return undefined;
  }
  return epochMs;
}

function isNonEmptyDisplayText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyText(values: readonly (string | null)[]): boolean {
  return values.some((value) => value !== null && value.trim().length > 0);
}

/** Validates and classifies one parsed JSON value without returning raw or excluded fields. */
export function classifySpotifyRecord(value: unknown): SpotifyRecordClassification {
  if (!isObjectRecord(value)) {
    return malformed(SpotifyRecordRejectionReason.InvalidRecord);
  }

  const stoppedAtEpochMs = parseUtcTimestamp(value.ts);
  if (stoppedAtEpochMs === undefined) {
    return malformed(SpotifyRecordRejectionReason.InvalidTimestamp);
  }
  if (!Number.isSafeInteger(value.ms_played) || (value.ms_played as number) < 0) {
    return malformed(SpotifyRecordRejectionReason.InvalidDuration);
  }
  const msPlayed = value.ms_played as number;
  const startedAtEpochMs = stoppedAtEpochMs - msPlayed;
  if (!Number.isSafeInteger(startedAtEpochMs) || startedAtEpochMs < 0) {
    return malformed(SpotifyRecordRejectionReason.InvalidTimeArithmetic);
  }

  const spotifyTrackUri = nullableString(value, "spotify_track_uri");
  const spotifyEpisodeUri = nullableString(value, "spotify_episode_uri");
  const episodeName = nullableString(value, "episode_name");
  const episodeShowName = nullableString(value, "episode_show_name");
  const audiobookTitle = nullableString(value, "audiobook_title");
  const audiobookUri = nullableString(value, "audiobook_uri");
  const audiobookChapterUri = nullableString(value, "audiobook_chapter_uri");
  const audiobookChapterTitle = nullableString(value, "audiobook_chapter_title");
  if (
    spotifyTrackUri === undefined ||
    spotifyEpisodeUri === undefined ||
    episodeName === undefined ||
    episodeShowName === undefined ||
    audiobookTitle === undefined ||
    audiobookUri === undefined ||
    audiobookChapterUri === undefined ||
    audiobookChapterTitle === undefined
  ) {
    return malformed(SpotifyRecordRejectionReason.InvalidFieldType);
  }

  const artistName = nullableString(value, "master_metadata_album_artist_name");
  const albumName = nullableString(value, "master_metadata_album_album_name");
  const trackName = nullableString(value, "master_metadata_track_name");
  const reasonStart = nullableString(value, "reason_start");
  const reasonEnd = nullableString(value, "reason_end");
  const skipped = nullableBoolean(value, "skipped");
  const offline = nullableBoolean(value, "offline");
  const offlineTimestamp = nullableSafeNonNegativeInteger(value, "offline_timestamp");
  if (
    artistName === undefined ||
    albumName === undefined ||
    trackName === undefined ||
    reasonStart === undefined ||
    reasonEnd === undefined ||
    skipped === undefined ||
    offline === undefined ||
    offlineTimestamp === undefined ||
    typeof value.shuffle !== "boolean"
  ) {
    return malformed(SpotifyRecordRejectionReason.InvalidFieldType);
  }

  if (spotifyTrackUri === null) {
    const nonMusicMarkers = [
      spotifyEpisodeUri,
      episodeName,
      episodeShowName,
      audiobookTitle,
      audiobookUri,
      audiobookChapterUri,
      audiobookChapterTitle,
    ];
    return {
      kind: "excluded",
      code: IngestIssueCode.ExcludedNonMusicRecord,
      category: hasNonEmptyText(nonMusicMarkers)
        ? SpotifyExcludedContent.EpisodeOrAudiobook
        : SpotifyExcludedContent.VideoOrUnsupported,
    };
  }

  if (!SPOTIFY_TRACK_URI_PATTERN.test(spotifyTrackUri)) {
    return malformed(SpotifyRecordRejectionReason.InvalidTrackUri);
  }

  if (!isNonEmptyDisplayText(artistName) || !isNonEmptyDisplayText(trackName)) {
    return malformed(SpotifyRecordRejectionReason.InvalidTrackMetadata);
  }

  return {
    kind: "track",
    record: {
      albumName,
      artistName,
      msPlayed,
      offline,
      offlineTimestamp,
      reasonEnd,
      reasonStart,
      shuffle: value.shuffle,
      skipped,
      spotifyTrackUri,
      startedAtEpochMs,
      stoppedAtEpochMs,
      trackName,
    },
  };
}

/** Parses a complete supported Spotify audio export and safely classifies every array member. */
export function parseSpotifyAudioExport(contents: string): readonly SpotifyClassifiedRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new SpotifyFileBoundaryError();
  }
  if (!Array.isArray(parsed)) {
    throw new SpotifyFileBoundaryError();
  }

  return parsed.map((value, ordinal) => ({ ordinal, ...classifySpotifyRecord(value) }));
}
