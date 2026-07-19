import { IngestIssueCode, IngestIssueSummary } from "../contracts.ts";
import { fingerprintSourceRecord } from "../hashing.ts";

export const LASTFM_SOURCE_FINGERPRINT_VERSION = "lastfm-source-v1";
export const LASTFM_OVERLAP_FINGERPRINT_VERSION = "lastfm-overlap-v1";

export const LastfmRecordRejectionReason = {
  InvalidFieldType: "invalid_field_type",
  InvalidRecord: "invalid_record",
  InvalidRequiredText: "invalid_required_text",
  InvalidTimestamp: "invalid_timestamp",
} as const;

export type LastfmRecordRejectionReason =
  (typeof LastfmRecordRejectionReason)[keyof typeof LastfmRecordRejectionReason];

/** The complete privacy-reviewed projection that may cross the Last.fm export boundary. */
export interface LastfmScrobbleSourceRecord {
  readonly albumName: string | null;
  readonly artistMusicbrainzId: string | null;
  readonly artistName: string;
  readonly loved: boolean | null;
  readonly recordingMusicbrainzId: string | null;
  readonly releaseMusicbrainzId: string | null;
  readonly scrobbledAtEpochMs: number;
  readonly trackName: string;
}

export type LastfmRecordClassification =
  | {
      readonly kind: "scrobble";
      readonly overlapFingerprintSha256: string;
      readonly record: LastfmScrobbleSourceRecord;
      readonly sourceFingerprintSha256: string;
    }
  | {
      readonly code: typeof IngestIssueCode.RejectedRecord;
      readonly kind: "malformed";
      readonly reason: LastfmRecordRejectionReason;
    };

export type LastfmClassifiedRecord = LastfmRecordClassification & {
  readonly ordinal: number;
};

export class LastfmFileBoundaryError extends Error {
  readonly code = IngestIssueCode.MalformedFile;
  readonly safeSummary = IngestIssueSummary[IngestIssueCode.MalformedFile];

  constructor() {
    super(IngestIssueSummary[IngestIssueCode.MalformedFile]);
    this.name = "LastfmFileBoundaryError";
  }
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(reason: LastfmRecordRejectionReason): LastfmRecordClassification {
  return { kind: "malformed", code: IngestIssueCode.RejectedRecord, reason };
}

function optionalDisplayText(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim().length === 0 ? null : value;
}

function optionalBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean | null | undefined {
  const value = record[key];
  return value === undefined || value === null || typeof value === "boolean"
    ? (value ?? null)
    : undefined;
}

/** Creates an immutable identity for the complete approved source-record projection. */
export function fingerprintLastfmScrobble(record: LastfmScrobbleSourceRecord): string {
  return fingerprintSourceRecord({
    sourceKind: "lastfm",
    version: LASTFM_SOURCE_FINGERPRINT_VERSION,
    fields: {
      albumName: record.albumName,
      artistMusicbrainzId: record.artistMusicbrainzId,
      artistName: record.artistName,
      loved: record.loved,
      recordingMusicbrainzId: record.recordingMusicbrainzId,
      releaseMusicbrainzId: record.releaseMusicbrainzId,
      scrobbledAtEpochMs: record.scrobbledAtEpochMs,
      trackName: record.trackName,
    },
  });
}

/**
 * Creates an export/API overlap candidate key. Metadata that can differ by origin is omitted, but
 * this key never replaces the complete source fingerprint or authorizes evidence to be discarded.
 */
export function fingerprintLastfmScrobbleOverlap(record: LastfmScrobbleSourceRecord): string {
  return fingerprintSourceRecord({
    sourceKind: "lastfm",
    version: LASTFM_OVERLAP_FINGERPRINT_VERSION,
    fields: {
      artistName: record.artistName,
      scrobbledAtEpochMs: record.scrobbledAtEpochMs,
      trackName: record.trackName,
    },
  });
}

/** Validates one parsed export value and returns only approved fields and safe diagnostics. */
export function classifyLastfmRecord(value: unknown): LastfmRecordClassification {
  if (!isObjectRecord(value)) {
    return malformed(LastfmRecordRejectionReason.InvalidRecord);
  }

  if (!Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) {
    return malformed(LastfmRecordRejectionReason.InvalidTimestamp);
  }
  if (typeof value.artist_name !== "string" || typeof value.track_name !== "string") {
    return malformed(LastfmRecordRejectionReason.InvalidFieldType);
  }
  if (value.artist_name.trim().length === 0 || value.track_name.trim().length === 0) {
    return malformed(LastfmRecordRejectionReason.InvalidRequiredText);
  }

  const albumName = optionalDisplayText(value, "album_name");
  const artistMusicbrainzId = optionalDisplayText(value, "artist_musicbrainz_id");
  const releaseMusicbrainzId = optionalDisplayText(value, "release_musicbrainz_id");
  const recordingMusicbrainzId = optionalDisplayText(value, "recording_musicbrainz_id");
  const loved = optionalBoolean(value, "loved");
  if (
    albumName === undefined ||
    artistMusicbrainzId === undefined ||
    releaseMusicbrainzId === undefined ||
    recordingMusicbrainzId === undefined ||
    loved === undefined
  ) {
    return malformed(LastfmRecordRejectionReason.InvalidFieldType);
  }

  const record: LastfmScrobbleSourceRecord = {
    albumName,
    artistMusicbrainzId,
    artistName: value.artist_name,
    loved,
    recordingMusicbrainzId,
    releaseMusicbrainzId,
    scrobbledAtEpochMs: value.timestamp as number,
    trackName: value.track_name,
  };
  return {
    kind: "scrobble",
    overlapFingerprintSha256: fingerprintLastfmScrobbleOverlap(record),
    record,
    sourceFingerprintSha256: fingerprintLastfmScrobble(record),
  };
}

/** Parses a complete supported Last.fm export and classifies every array member. */
export function parseLastfmExport(contents: string): readonly LastfmClassifiedRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new LastfmFileBoundaryError();
  }
  if (!Array.isArray(parsed)) {
    throw new LastfmFileBoundaryError();
  }

  return parsed.map((value, ordinal) => ({ ordinal, ...classifyLastfmRecord(value) }));
}
