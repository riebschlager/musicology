import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import { ARCHIVE_BASELINE } from "./archive-baseline.ts";

export const COVERAGE_REPORT_VERSION = "coverage-v2";
export const LONG_GAP_THRESHOLD_DAYS = 365;
const DAY_MS = 86_400_000;

export type CoverageSource = "lastfm" | "spotify";

interface TimestampRow extends SqliteRow {
  readonly observed_at_epoch_ms: number;
}

interface SourceFileRow extends SqliteRow {
  readonly source_type: "lastfm_export" | "spotify_export";
  readonly content_sha256: string;
}

interface CountRow extends SqliteRow {
  readonly count: number;
}

interface MissingFieldDefinition {
  readonly field: string;
  readonly expression: string;
}

export interface CoverageYear {
  readonly year: number;
  readonly evidenceCount: number;
}

export interface CoverageRange {
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

export interface CoverageLongGap {
  readonly after: string;
  readonly before: string;
  readonly durationDays: number;
}

export interface CoverageMissingField {
  readonly field: string;
  readonly missingCount: number;
  readonly totalCount: number;
  readonly missingRate: number;
}

export interface SourceCoverage {
  readonly source: CoverageSource;
  readonly evidenceCount: number;
  readonly byYear: readonly CoverageYear[];
  readonly observedRange: CoverageRange | null;
  readonly totals: {
    readonly accepted: number;
    readonly rejected: number;
    readonly nonMusic: number;
  };
  readonly duplicates: {
    readonly groupCount: number;
    readonly extraEvidenceCount: number;
  };
  readonly missingFields: readonly CoverageMissingField[];
  readonly longGaps: readonly CoverageLongGap[];
}

export interface ArchiveBaselineDeviation {
  readonly metric: string;
  readonly actual: number;
  readonly expected: number;
}

export interface ArchiveBaselineComparison {
  readonly version: string;
  readonly matches: boolean;
  readonly deviations: readonly ArchiveBaselineDeviation[];
}

export interface CanonicalCoverageBySourceBacking {
  readonly spotify: number;
  readonly lastfm: number;
  readonly both: number;
}

export interface CanonicalCoverageMergeCounts {
  readonly exactDuplicateEvents: number;
  readonly exactDuplicateSourceLinks: number;
  readonly inferredCrossSourceEvents: number;
  readonly inferredCrossSourceSourceLinks: number;
}

export interface CanonicalCoverageOverlapYear {
  readonly year: number;
  readonly eventCount: number;
}

export interface CanonicalCoverage {
  readonly eventCount: number;
  readonly bySourceBacking: CanonicalCoverageBySourceBacking;
  readonly merges: CanonicalCoverageMergeCounts;
  readonly unresolved: {
    readonly eventCount: number;
    readonly rate: number;
  };
  readonly overlapByYear: readonly CanonicalCoverageOverlapYear[];
}

export interface CoverageReport {
  readonly reportVersion: string;
  readonly generatedAt: string;
  readonly timezone: string;
  readonly semantics: {
    readonly countLayer: "source_evidence_occurrences";
    readonly canonicalEventCountsIncluded: true;
    readonly longGapThresholdDays: number;
    readonly longGapDefinition: string;
  };
  readonly inputFiles: readonly {
    readonly source: CoverageSource;
    readonly sha256: string;
  }[];
  readonly totals: {
    readonly evidenceOccurrences: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly nonMusic: number;
    readonly canonicalEvents: number;
  };
  readonly canonical: CanonicalCoverage;
  readonly sources: readonly SourceCoverage[];
  readonly archiveBaselineComparison?: ArchiveBaselineComparison;
}

export interface GenerateCoverageReportOptions {
  readonly connection: SqliteConnection;
  readonly timezone: string;
  readonly now?: () => number;
  readonly compareArchiveBaseline?: boolean;
}

const SPOTIFY_MISSING_FIELDS = [
  { field: "albumName", expression: "album_name IS NULL" },
  { field: "reasonStart", expression: "reason_start IS NULL" },
  { field: "reasonEnd", expression: "reason_end IS NULL" },
  { field: "skipped", expression: "skipped IS NULL" },
  { field: "offline", expression: "offline IS NULL" },
  { field: "offlineAt", expression: "offline_at_epoch_ms IS NULL" },
] as const satisfies readonly MissingFieldDefinition[];

const LASTFM_MISSING_FIELDS = [
  { field: "albumName", expression: "evidence.album_name IS NULL" },
  { field: "artistMusicBrainzId", expression: "evidence.artist_musicbrainz_id IS NULL" },
  { field: "releaseMusicBrainzId", expression: "evidence.release_musicbrainz_id IS NULL" },
  { field: "recordingMusicBrainzId", expression: "evidence.recording_musicbrainz_id IS NULL" },
  { field: "loved", expression: "evidence.loved IS NULL" },
] as const satisfies readonly MissingFieldDefinition[];

function count(connection: SqliteConnection, sql: string): number {
  return connection.prepare<CountRow>(sql).get()?.count ?? 0;
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function reportYearFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US-u-nu-latn", {
    timeZone: timezone,
    year: "numeric",
  });
}

function timestampsForSource(
  connection: SqliteConnection,
  source: CoverageSource,
): readonly number[] {
  const sql =
    source === "spotify"
      ? `SELECT stopped_at_epoch_ms AS observed_at_epoch_ms
         FROM spotify_play_source
         ORDER BY stopped_at_epoch_ms, source_record_id`
      : `SELECT evidence.scrobbled_at_epoch_ms AS observed_at_epoch_ms
         FROM lastfm_scrobble_occurrence AS occurrence
         JOIN lastfm_scrobble_source AS evidence
           ON evidence.source_record_id = occurrence.lastfm_scrobble_source_record_id
         ORDER BY evidence.scrobbled_at_epoch_ms, occurrence.source_record_id`;
  return connection
    .prepare<TimestampRow>(sql)
    .all()
    .map((row) => row.observed_at_epoch_ms);
}

function coverageByYear(timestamps: readonly number[], timezone: string): readonly CoverageYear[] {
  const formatter = reportYearFormatter(timezone);
  const counts = new Map<number, number>();
  for (const timestamp of timestamps) {
    const year = Number(formatter.format(timestamp));
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([year, evidenceCount]) => ({ year, evidenceCount }));
}

function observedRange(timestamps: readonly number[]): CoverageRange | null {
  const first = timestamps[0];
  const last = timestamps.at(-1);
  return first === undefined || last === undefined
    ? null
    : { firstObservedAt: iso(first), lastObservedAt: iso(last) };
}

function longGaps(timestamps: readonly number[]): readonly CoverageLongGap[] {
  const gaps: CoverageLongGap[] = [];
  let previous = timestamps[0];
  if (previous === undefined) {
    return gaps;
  }
  for (const current of timestamps.slice(1)) {
    const durationMs = current - previous;
    if (durationMs >= LONG_GAP_THRESHOLD_DAYS * DAY_MS) {
      gaps.push({
        after: iso(previous),
        before: iso(current),
        durationDays: durationMs / DAY_MS,
      });
    }
    previous = current;
  }
  return gaps;
}

function missingFields(
  connection: SqliteConnection,
  fromClause: string,
  definitions: readonly MissingFieldDefinition[],
  totalCount: number,
): readonly CoverageMissingField[] {
  return definitions.map((definition) => {
    const missingCount = count(
      connection,
      `SELECT count(*) AS count FROM ${fromClause} WHERE ${definition.expression}`,
    );
    return {
      field: definition.field,
      missingCount,
      totalCount,
      missingRate: totalCount === 0 ? 0 : missingCount / totalCount,
    };
  });
}

function sourceCoverage(
  connection: SqliteConnection,
  source: CoverageSource,
  timezone: string,
): SourceCoverage {
  const timestamps = timestampsForSource(connection, source);
  const isSpotify = source === "spotify";
  const sourceTable = isSpotify
    ? "spotify_play_source"
    : `lastfm_scrobble_occurrence AS occurrence
       JOIN lastfm_scrobble_source AS evidence
         ON evidence.source_record_id = occurrence.lastfm_scrobble_source_record_id`;
  const sourceKind = isSpotify ? "spotify" : "lastfm";
  const commandType = isSpotify ? "spotify_import" : "lastfm_export_import";
  const accepted = timestamps.length;
  const duplicateQuery = isSpotify
    ? `SELECT count(*) AS count FROM (
         SELECT source_fingerprint_sha256
         FROM spotify_play_source
         GROUP BY source_fingerprint_sha256
         HAVING count(*) > 1
       )`
    : `SELECT count(*) AS count FROM (
         SELECT lastfm_scrobble_source_record_id
         FROM lastfm_scrobble_occurrence
         GROUP BY lastfm_scrobble_source_record_id
         HAVING count(*) > 1
       )`;
  const extraDuplicateQuery = isSpotify
    ? `SELECT coalesce(sum(group_size - 1), 0) AS count FROM (
         SELECT count(*) AS group_size
         FROM spotify_play_source
         GROUP BY source_fingerprint_sha256
       )`
    : `SELECT coalesce(sum(group_size - 1), 0) AS count FROM (
         SELECT count(*) AS group_size
         FROM lastfm_scrobble_occurrence
         GROUP BY lastfm_scrobble_source_record_id
       )`;

  return {
    source,
    evidenceCount: accepted,
    byYear: coverageByYear(timestamps, timezone),
    observedRange: observedRange(timestamps),
    totals: {
      accepted,
      rejected: count(
        connection,
        `SELECT count(*) AS count FROM rejected_source_record WHERE source_kind = '${sourceKind}'`,
      ),
      nonMusic: count(
        connection,
        `SELECT coalesce(sum(excluded_count), 0) AS count
         FROM ingest_run
         WHERE command_type = '${commandType}' AND status = 'succeeded'`,
      ),
    },
    duplicates: {
      groupCount: count(connection, duplicateQuery),
      extraEvidenceCount: count(connection, extraDuplicateQuery),
    },
    missingFields: missingFields(
      connection,
      sourceTable,
      isSpotify ? SPOTIFY_MISSING_FIELDS : LASTFM_MISSING_FIELDS,
      accepted,
    ),
    longGaps: longGaps(timestamps),
  };
}

function archiveBaselineComparison(sources: readonly SourceCoverage[]): ArchiveBaselineComparison {
  const spotify = sources.find((source) => source.source === "spotify");
  const lastfm = sources.find((source) => source.source === "lastfm");
  if (spotify === undefined || lastfm === undefined) {
    throw new Error("Coverage sources are incomplete");
  }
  const metrics = [
    ["spotifyAccepted", spotify.totals.accepted, ARCHIVE_BASELINE.spotifyAccepted],
    [
      "spotifyDuplicated",
      spotify.duplicates.extraEvidenceCount,
      ARCHIVE_BASELINE.spotifyDuplicated,
    ],
    ["spotifyExcluded", spotify.totals.nonMusic, ARCHIVE_BASELINE.spotifyExcluded],
    ["spotifyRejected", spotify.totals.rejected, ARCHIVE_BASELINE.spotifyRejected],
    ["lastfmAccepted", lastfm.totals.accepted, ARCHIVE_BASELINE.lastfmAccepted],
    ["lastfmDuplicated", lastfm.duplicates.extraEvidenceCount, ARCHIVE_BASELINE.lastfmDuplicated],
    ["lastfmRejected", lastfm.totals.rejected, ARCHIVE_BASELINE.lastfmRejected],
  ] as const;
  const deviations = metrics
    .filter(([, actual, expected]) => actual !== expected)
    .map(([metric, actual, expected]) => ({ metric, actual, expected }));
  return { version: ARCHIVE_BASELINE.version, matches: deviations.length === 0, deviations };
}

interface CanonicalBackingRow extends SqliteRow {
  readonly source_backing: "both" | "lastfm" | "spotify";
  readonly count: number;
}

interface CanonicalYearRow extends SqliteRow {
  readonly observed_at_epoch_ms: number;
}

function canonicalCoverage(connection: SqliteConnection, timezone: string): CanonicalCoverage {
  const backingRows = connection
    .prepare<CanonicalBackingRow>(
      `SELECT CASE
              WHEN count(DISTINCT source.source_kind) = 2 THEN 'both'
                WHEN max(source.source_kind) = 'spotify' THEN 'spotify'
                ELSE 'lastfm'
              END AS source_backing,
              1 AS count
         FROM listening_event AS event
         JOIN listening_event_source AS link ON link.listening_event_id = event.id
         JOIN source_record AS source ON source.id = link.source_record_id
        WHERE event.event_status <> 'superseded'
        GROUP BY event.id`,
    )
    .all();
  const bySourceBacking: Record<CanonicalBackingRow["source_backing"], number> = {
    lastfm: 0,
    spotify: 0,
    both: 0,
  };
  for (const row of backingRows) bySourceBacking[row.source_backing] += row.count;
  const eventCount = bySourceBacking.spotify + bySourceBacking.lastfm + bySourceBacking.both;
  const exactDuplicateEvents = count(
    connection,
    `SELECT count(*) AS count
       FROM listening_event AS event
      WHERE event.event_status <> 'superseded'
        AND EXISTS (
          SELECT 1 FROM listening_event_source AS link
           WHERE link.listening_event_id = event.id AND link.evidence_role = 'exact_duplicate'
        )`,
  );
  const exactDuplicateSourceLinks = count(
    connection,
    "SELECT count(*) AS count FROM listening_event_source WHERE evidence_role = 'exact_duplicate'",
  );
  const inferredCrossSourceEvents = count(
    connection,
    `SELECT count(*) AS count
       FROM listening_event AS event
      WHERE event.event_status <> 'superseded'
        AND EXISTS (
          SELECT 1 FROM listening_event_source AS link
           WHERE link.listening_event_id = event.id AND link.evidence_role = 'cross_source_match'
        )`,
  );
  const inferredCrossSourceSourceLinks = count(
    connection,
    "SELECT count(*) AS count FROM listening_event_source WHERE evidence_role = 'cross_source_match'",
  );
  const unresolvedEventCount = count(
    connection,
    "SELECT count(*) AS count FROM listening_event WHERE event_status = 'unresolved'",
  );
  const formatter = reportYearFormatter(timezone);
  const overlapYears = new Map<number, number>();
  const overlapTimestamps = connection
    .prepare<CanonicalYearRow>(
      `SELECT coalesce(event.started_at_epoch_ms, event.ended_at_epoch_ms) AS observed_at_epoch_ms
         FROM listening_event AS event
         JOIN listening_event_source AS link ON link.listening_event_id = event.id
         JOIN source_record AS source ON source.id = link.source_record_id
        WHERE event.event_status <> 'superseded'
        GROUP BY event.id
       HAVING count(DISTINCT source.source_kind) = 2
        ORDER BY observed_at_epoch_ms, event.id`,
    )
    .all();
  for (const row of overlapTimestamps) {
    const year = Number(formatter.format(row.observed_at_epoch_ms));
    overlapYears.set(year, (overlapYears.get(year) ?? 0) + 1);
  }

  return {
    eventCount,
    bySourceBacking,
    merges: {
      exactDuplicateEvents,
      exactDuplicateSourceLinks,
      inferredCrossSourceEvents,
      inferredCrossSourceSourceLinks,
    },
    unresolved: {
      eventCount: unresolvedEventCount,
      rate: eventCount === 0 ? 0 : unresolvedEventCount / eventCount,
    },
    overlapByYear: [...overlapYears.entries()]
      .sort(([left], [right]) => left - right)
      .map(([year, count]) => ({ year, eventCount: count })),
  };
}

/** Builds a deterministic evidence-layer report from one committed database snapshot. */
export function generateCoverageReport(options: GenerateCoverageReportOptions): CoverageReport {
  const generatedAtEpochMs = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(generatedAtEpochMs) || generatedAtEpochMs < 0) {
    throw new Error("Coverage report generation time must be a non-negative safe integer");
  }

  return options.connection.transaction((connection) => {
    const sources = (["spotify", "lastfm"] as const).map((source) =>
      sourceCoverage(connection, source, options.timezone),
    );
    const inputFiles = connection
      .prepare<SourceFileRow>(
        `SELECT source_type, content_sha256
         FROM source_file
         ORDER BY source_type, content_sha256`,
      )
      .all()
      .map((file) => ({
        source: file.source_type === "spotify_export" ? ("spotify" as const) : ("lastfm" as const),
        sha256: file.content_sha256,
      }));
    const evidenceOccurrences = sources.reduce((sum, source) => sum + source.evidenceCount, 0);
    const rejected = sources.reduce((sum, source) => sum + source.totals.rejected, 0);
    const nonMusic = sources.reduce((sum, source) => sum + source.totals.nonMusic, 0);
    const canonical = canonicalCoverage(connection, options.timezone);

    return {
      reportVersion: COVERAGE_REPORT_VERSION,
      generatedAt: iso(generatedAtEpochMs),
      timezone: options.timezone,
      semantics: {
        countLayer: "source_evidence_occurrences",
        canonicalEventCountsIncluded: true,
        longGapThresholdDays: LONG_GAP_THRESHOLD_DAYS,
        longGapDefinition:
          "Consecutive observations from the same source separated by at least 365 exact 24-hour days.",
      },
      inputFiles,
      totals: {
        evidenceOccurrences,
        accepted: evidenceOccurrences,
        rejected,
        nonMusic,
        canonicalEvents: canonical.eventCount,
      },
      canonical,
      sources,
      ...(options.compareArchiveBaseline
        ? { archiveBaselineComparison: archiveBaselineComparison(sources) }
        : {}),
    };
  }, "deferred");
}
