import type { SqliteConnection, SqliteRow } from "../db/connection.ts";

/** Semantic version of the inspectable canonical analytical-base query. */
export const CANONICAL_ANALYTICAL_BASE_QUERY_VERSION = "canonical-analytical-base-v1";

/**
 * This query returns one active canonical event per row. Source evidence is aggregated before
 * joining, so a reconciled event with Spotify and Last.fm backing cannot be counted twice.
 */
export const CANONICAL_ANALYTICAL_BASE_SQL = `
  WITH source_backing AS (
    SELECT link.listening_event_id,
           count(*) AS source_record_count,
           sum(CASE WHEN source.source_kind = 'spotify' THEN 1 ELSE 0 END) AS spotify_source_record_count,
           sum(CASE WHEN source.source_kind = 'lastfm' THEN 1 ELSE 0 END) AS lastfm_source_record_count,
           max(CASE WHEN source.source_kind = 'spotify' THEN 1 ELSE 0 END) AS has_spotify_source,
           max(CASE WHEN source.source_kind = 'lastfm' THEN 1 ELSE 0 END) AS has_lastfm_source,
           max(CASE WHEN source.source_kind = 'spotify' THEN spotify.ms_played END) AS spotify_duration_ms
      FROM listening_event_source AS link
      JOIN source_record AS source ON source.id = link.source_record_id
      LEFT JOIN spotify_play_source AS spotify ON spotify.source_record_id = source.id
     GROUP BY link.listening_event_id
  )
  SELECT event.id AS listening_event_id,
         event.track_id,
         artist.id AS artist_id,
         artist.preferred_name AS artist_display_name,
         track.preferred_title AS track_display_title,
         event.started_at_epoch_ms,
         event.ended_at_epoch_ms,
         coalesce(event.started_at_epoch_ms, event.ended_at_epoch_ms) AS calendar_instant_epoch_ms,
         event.listened_ms AS canonical_listened_ms,
         event.time_basis,
         event.event_status,
         event.reconciliation_rule_version,
         backing.source_record_count,
         backing.spotify_source_record_count,
         backing.lastfm_source_record_count,
         backing.has_spotify_source,
         backing.has_lastfm_source,
         backing.spotify_duration_ms,
         CASE
           WHEN event.event_status = 'unresolved' THEN 'unresolved'
           WHEN backing.has_spotify_source = 1 AND backing.has_lastfm_source = 1 THEN 'cross_source_reconciled'
           ELSE 'single_source'
         END AS reconciliation_status
    FROM listening_event AS event
    JOIN track ON track.id = event.track_id
    JOIN artist ON artist.id = track.artist_id
    JOIN source_backing AS backing ON backing.listening_event_id = event.id
   WHERE event.event_status IN ('current', 'unresolved')
   ORDER BY calendar_instant_epoch_ms, event.id
`;

export type ReconciliationStatus = "cross_source_reconciled" | "single_source" | "unresolved";

export interface CalendarProjection {
  readonly day: string;
  readonly isoWeek: string;
  readonly month: string;
  readonly quarter: string;
  readonly year: string;
}

export interface CanonicalAnalyticalBaseEvent {
  readonly artistDisplayName: string;
  readonly artistId: number;
  readonly calendar: CalendarProjection;
  readonly calendarInstantEpochMs: number;
  readonly canonicalListenedMs: number | null;
  readonly endedAtEpochMs: number | null;
  readonly eventStatus: "current" | "unresolved";
  readonly hasLastfmSource: boolean;
  readonly hasSpotifySource: boolean;
  readonly lastfmSourceRecordCount: number;
  readonly listeningEventId: number;
  readonly reconciliationRuleVersion: string;
  readonly reconciliationStatus: ReconciliationStatus;
  readonly sourceRecordCount: number;
  readonly spotifyDurationMs: number | null;
  readonly spotifySourceRecordCount: number;
  readonly startedAtEpochMs: number | null;
  readonly timeBasis: "derived_start" | "observed_end" | "observed_start";
  readonly trackDisplayTitle: string;
  readonly trackId: number;
}

interface CanonicalAnalyticalBaseRow extends SqliteRow {
  readonly artist_display_name: string;
  readonly artist_id: number;
  readonly calendar_instant_epoch_ms: number;
  readonly canonical_listened_ms: number | null;
  readonly ended_at_epoch_ms: number | null;
  readonly event_status: "current" | "unresolved";
  readonly has_lastfm_source: 0 | 1;
  readonly has_spotify_source: 0 | 1;
  readonly lastfm_source_record_count: number;
  readonly listening_event_id: number;
  readonly reconciliation_rule_version: string;
  readonly reconciliation_status: ReconciliationStatus;
  readonly source_record_count: number;
  readonly spotify_duration_ms: number | null;
  readonly spotify_source_record_count: number;
  readonly started_at_epoch_ms: number | null;
  readonly time_basis: "derived_start" | "observed_end" | "observed_start";
  readonly track_display_title: string;
  readonly track_id: number;
}

/**
 * Returns active canonical events with source coverage and calendar projections. Callers must
 * name a presentation timezone explicitly; no host-local timezone is consulted.
 */
export function queryCanonicalAnalyticalBase(
  connection: SqliteConnection,
  presentationTimezone: string,
): readonly CanonicalAnalyticalBaseEvent[] {
  const calendarFormatter = createCalendarFormatter(presentationTimezone);
  return connection
    .prepare<CanonicalAnalyticalBaseRow>(CANONICAL_ANALYTICAL_BASE_SQL)
    .all()
    .map((row) => ({
      artistDisplayName: row.artist_display_name,
      artistId: row.artist_id,
      calendar: projectCalendar(row.calendar_instant_epoch_ms, calendarFormatter),
      calendarInstantEpochMs: row.calendar_instant_epoch_ms,
      canonicalListenedMs: row.canonical_listened_ms,
      endedAtEpochMs: row.ended_at_epoch_ms,
      eventStatus: row.event_status,
      hasLastfmSource: row.has_lastfm_source === 1,
      hasSpotifySource: row.has_spotify_source === 1,
      lastfmSourceRecordCount: row.lastfm_source_record_count,
      listeningEventId: row.listening_event_id,
      reconciliationRuleVersion: row.reconciliation_rule_version,
      reconciliationStatus: row.reconciliation_status,
      sourceRecordCount: row.source_record_count,
      spotifyDurationMs: row.spotify_duration_ms,
      spotifySourceRecordCount: row.spotify_source_record_count,
      startedAtEpochMs: row.started_at_epoch_ms,
      timeBasis: row.time_basis,
      trackDisplayTitle: row.track_display_title,
      trackId: row.track_id,
    }));
}

function createCalendarFormatter(presentationTimezone: string): Intl.DateTimeFormat {
  if (presentationTimezone.trim() === "") {
    throw new RangeError("Presentation timezone must name a valid IANA timezone");
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      calendar: "gregory",
      day: "2-digit",
      month: "2-digit",
      numberingSystem: "latn",
      timeZone: presentationTimezone,
      year: "numeric",
    });
  } catch {
    throw new RangeError("Presentation timezone must name a valid IANA timezone");
  }
}

function projectCalendar(epochMs: number, formatter: Intl.DateTimeFormat): CalendarProjection {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const yearText = parts.year;
  const year = Number(yearText);
  const month = Number(parts.month);
  const day = Number(parts.day);
  if (
    yearText === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new Error("Calendar projection did not produce a Gregorian date");
  }

  const iso = isoWeekForGregorianDate(year, month, day);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    isoWeek: `${iso.year}-W${String(iso.week).padStart(2, "0")}`,
    month: `${parts.year}-${parts.month}`,
    quarter: `${parts.year}-Q${Math.floor((month - 1) / 3) + 1}`,
    year: yearText,
  };
}

function isoWeekForGregorianDate(
  year: number,
  month: number,
  day: number,
): Readonly<{ year: number; week: number }> {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  return {
    week: Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7),
    year: isoYear,
  };
}
