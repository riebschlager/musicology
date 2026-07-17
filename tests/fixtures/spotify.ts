import { FIXTURE_TIMES } from "./times.ts";

export interface SpotifyFixtureRecord extends Readonly<Record<string, unknown>> {
  readonly ts: string;
  readonly ms_played: number;
  readonly master_metadata_track_name: string | null;
  readonly master_metadata_album_artist_name: string | null;
  readonly master_metadata_album_album_name: string | null;
  readonly spotify_track_uri: string | null;
  readonly episode_name: string | null;
  readonly episode_show_name: string | null;
  readonly spotify_episode_uri: string | null;
  readonly reason_start: string | null;
  readonly reason_end: string | null;
  readonly shuffle: boolean;
  readonly skipped: boolean | null;
  readonly offline: boolean | null;
  readonly offline_timestamp: number | null;
}

export type SpotifyFixtureOverrides = Readonly<Record<string, unknown>>;

const BASE_SPOTIFY_TRACK = {
  ts: "2026-01-02T03:04:05.678Z",
  ms_played: 187_000,
  master_metadata_track_name: "Clockwork Garden",
  master_metadata_album_artist_name: "The Synthetic Signals",
  master_metadata_album_album_name: "Reserved Test Tones",
  spotify_track_uri: "spotify:track:synthetic000000000001",
  episode_name: null,
  episode_show_name: null,
  spotify_episode_uri: null,
  reason_start: "trackdone",
  reason_end: "trackdone",
  shuffle: false,
  skipped: false,
  offline: false,
  offline_timestamp: null,
} as const satisfies SpotifyFixtureRecord;

export function buildSpotifyTrackFixture(
  overrides: SpotifyFixtureOverrides = {},
): SpotifyFixtureRecord {
  return { ...BASE_SPOTIFY_TRACK, ...overrides } as SpotifyFixtureRecord;
}

export function buildSpotifyEpisodeFixture(
  overrides: SpotifyFixtureOverrides = {},
): SpotifyFixtureRecord {
  return {
    ...BASE_SPOTIFY_TRACK,
    master_metadata_track_name: null,
    master_metadata_album_artist_name: null,
    master_metadata_album_album_name: null,
    spotify_track_uri: null,
    episode_name: "A Completely Invented Episode",
    episode_show_name: "Synthetic Audio Hour",
    spotify_episode_uri: "spotify:episode:synthetic000000001",
    ...overrides,
  } as SpotifyFixtureRecord;
}

export const SPOTIFY_FIXTURE_CASES = [
  { case: "valid_track", record: buildSpotifyTrackFixture() },
  {
    case: "missing_optional_data",
    record: buildSpotifyTrackFixture({
      master_metadata_album_album_name: null,
      skipped: null,
      offline: null,
    }),
  },
  { case: "non_music_episode", record: buildSpotifyEpisodeFixture() },
  {
    case: "unicode",
    record: buildSpotifyTrackFixture({
      master_metadata_track_name: "雪のテスト — Café 🎧",
      master_metadata_album_artist_name: "Beyoncé de Prueba",
      master_metadata_album_album_name: "Señales синтетические",
      spotify_track_uri: "spotify:track:synthetic000000000002",
    }),
  },
  {
    case: "time_boundary_before",
    record: buildSpotifyTrackFixture({
      ts: FIXTURE_TIMES.chicagoDstBefore,
      spotify_track_uri: "spotify:track:synthetic000000000003",
    }),
  },
  {
    case: "time_boundary_after",
    record: buildSpotifyTrackFixture({
      ts: FIXTURE_TIMES.chicagoDstAfter,
      spotify_track_uri: "spotify:track:synthetic000000000004",
    }),
  },
  {
    case: "malformed",
    record: buildSpotifyTrackFixture({ ms_played: "not-a-number" }),
  },
] as const;

const exactDuplicate = buildSpotifyTrackFixture({
  ts: "2026-02-03T04:05:06.789Z",
  spotify_track_uri: "spotify:track:synthetic000000000005",
});

export const SPOTIFY_EXACT_DUPLICATE_FIXTURES = [
  { ...exactDuplicate },
  { ...exactDuplicate },
] as const;

export const SPOTIFY_AMBIGUOUS_OVERLAP_FIXTURES = [
  buildSpotifyTrackFixture({
    ts: FIXTURE_TIMES.ambiguousSpotifyFirstStop,
    ms_played: 180_000,
    master_metadata_track_name: "Ambiguous Echo",
    master_metadata_album_artist_name: "The Synthetic Signals",
    spotify_track_uri: "spotify:track:synthetic000000000006",
  }),
  buildSpotifyTrackFixture({
    ts: FIXTURE_TIMES.ambiguousSpotifySecondStop,
    ms_played: 182_000,
    master_metadata_track_name: "Ambiguous Echo",
    master_metadata_album_artist_name: "The Synthetic Signals",
    spotify_track_uri: "spotify:track:synthetic000000000006",
  }),
] as const;
