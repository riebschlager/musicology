import type { SqliteConnection } from "../db/connection.ts";

export const SupportedSourceType = {
  LastfmExport: "lastfm_export",
  SpotifyExport: "spotify_export",
} as const;

export type SupportedSourceType = (typeof SupportedSourceType)[keyof typeof SupportedSourceType];

export const HistoricalIngestCommand = {
  LastfmExport: "lastfm_export_import",
  Spotify: "spotify_import",
} as const;

export type HistoricalIngestCommand =
  (typeof HistoricalIngestCommand)[keyof typeof HistoricalIngestCommand];

/** Commands that create source evidence, including incremental API synchronization. */
export const SourceEvidenceIngestCommand = {
  ...HistoricalIngestCommand,
  LastfmApi: "lastfm_api_sync",
} as const;

export type SourceEvidenceIngestCommand =
  (typeof SourceEvidenceIngestCommand)[keyof typeof SourceEvidenceIngestCommand];

/** Stable, privacy-safe codes. They never contain source values or raw payloads. */
export const IngestIssueCode = {
  DuplicateRecord: "duplicate_source_record",
  ExcludedNonMusicRecord: "excluded_non_music_record",
  IngestFailed: "ingest_failed",
  MalformedFile: "malformed_source_file",
  RejectedRecord: "rejected_source_record",
  SourceFileChanged: "source_file_changed",
  UnsupportedFile: "unsupported_source_file",
} as const;

export type IngestIssueCode = (typeof IngestIssueCode)[keyof typeof IngestIssueCode];

/** Fixed, privacy-reviewed summaries for persistence and user-facing errors. */
export const IngestIssueSummary: Readonly<Record<IngestIssueCode, string>> = {
  [IngestIssueCode.DuplicateRecord]: "Source record duplicates accepted evidence",
  [IngestIssueCode.ExcludedNonMusicRecord]: "Source record is valid excluded non-music evidence",
  [IngestIssueCode.IngestFailed]: "Import failed; no source evidence was committed",
  [IngestIssueCode.MalformedFile]: "Source file is malformed",
  [IngestIssueCode.RejectedRecord]: "Source record was rejected",
  [IngestIssueCode.SourceFileChanged]: "A registered source path now has different content",
  [IngestIssueCode.UnsupportedFile]: "Source file is not supported",
};

export interface DiscoveredSourceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sourceType: SupportedSourceType;
}

export interface HashedSourceFile extends DiscoveredSourceFile {
  readonly byteSize: number;
  readonly contentSha256: string;
}

export type SourceFileRegistration =
  | {
      readonly status: "registered";
      readonly sourceFileId: number;
    }
  | {
      readonly status: "already_registered";
      readonly matchedBy: "content_hash" | "path_and_hash";
      readonly sourceFileId: number;
    };

export type RecordOutcome =
  | {
      readonly kind: "accepted";
      readonly sourceFingerprintSha256: string;
    }
  | {
      readonly kind: "duplicate";
      readonly code: typeof IngestIssueCode.DuplicateRecord;
      readonly sourceFingerprintSha256: string;
    }
  | {
      readonly kind: "excluded";
      readonly code: typeof IngestIssueCode.ExcludedNonMusicRecord;
    }
  | {
      readonly kind: "rejected";
      readonly code: typeof IngestIssueCode.RejectedRecord;
    };

export interface IngestFileCounts {
  readonly discovered: number;
  readonly registered: number;
  readonly noOp: number;
  readonly unsupported: number;
}

export interface IngestRecordCounts {
  /** Accepted includes duplicate source rows because those rows remain evidence. */
  readonly accepted: number;
  /** Duplicated is a subset of accepted, not an additional discovered outcome. */
  readonly duplicated: number;
  readonly discovered: number;
  readonly excluded: number;
  readonly rejected: number;
}

export interface IngestSummary {
  readonly runId: number;
  readonly commandType: SourceEvidenceIngestCommand;
  readonly status: "succeeded";
  readonly noOp: boolean;
  readonly files: IngestFileCounts;
  readonly records: IngestRecordCounts;
}

export interface IngestRunContext {
  readonly connection: SqliteConnection;
  readonly runId: number;
  registerSourceFile(file: HashedSourceFile): SourceFileRegistration;
  recordOutcome(outcome: RecordOutcome): void;
  recordUnsupportedFile(): void;
}

/** A completed ingest run that is still inside the transaction that created its evidence. */
export interface SuccessfulIngestRunContext {
  readonly connection: SqliteConnection;
  readonly runId: number;
}

export interface IngestLifecycleOptions {
  /** Runs after successful lifecycle state is recorded, before its transaction commits. */
  readonly afterSuccess?: (context: SuccessfulIngestRunContext) => void;
  readonly commandType: SourceEvidenceIngestCommand;
  readonly connection: SqliteConnection;
  readonly now?: () => number;
  readonly ruleVersion?: string;
  readonly schemaVersion: string;
}

export type SourceFingerprintValue = boolean | null | number | string;

/** Source-specific discovery adapters must positively identify supported files. */
export interface SupportedSourceDiscovery {
  discover(candidatePaths: readonly string[]): readonly DiscoveredSourceFile[];
}
