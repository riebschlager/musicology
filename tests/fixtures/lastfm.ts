import { epochMilliseconds, FIXTURE_TIMES } from "./times.ts";

export interface LastfmFixtureRecord extends Readonly<Record<string, unknown>> {
  readonly timestamp: number;
  readonly artist_name: string;
  readonly album_name: string | null;
  readonly track_name: string;
  readonly artist_musicbrainz_id: string | null;
  readonly release_musicbrainz_id: string | null;
  readonly recording_musicbrainz_id: string | null;
  readonly loved: boolean | null;
}

export type LastfmFixtureOverrides = Readonly<Record<string, unknown>>;

const BASE_LASTFM_SCROBBLE = {
  timestamp: epochMilliseconds("2026-01-02T03:00:58.678Z"),
  artist_name: "The Synthetic Signals",
  album_name: "Reserved Test Tones",
  track_name: "Clockwork Garden",
  artist_musicbrainz_id: "00000000-0000-4000-8000-000000000001",
  release_musicbrainz_id: "00000000-0000-4000-8000-000000000002",
  recording_musicbrainz_id: "00000000-0000-4000-8000-000000000003",
  loved: false,
} as const satisfies LastfmFixtureRecord;

export function buildLastfmScrobbleFixture(
  overrides: LastfmFixtureOverrides = {},
): LastfmFixtureRecord {
  return { ...BASE_LASTFM_SCROBBLE, ...overrides } as LastfmFixtureRecord;
}

export const LASTFM_FIXTURE_CASES = [
  { case: "valid_scrobble", record: buildLastfmScrobbleFixture() },
  {
    case: "missing_optional_data",
    record: buildLastfmScrobbleFixture({
      album_name: null,
      artist_musicbrainz_id: null,
      release_musicbrainz_id: null,
      recording_musicbrainz_id: null,
      loved: null,
    }),
  },
  {
    case: "unicode",
    record: buildLastfmScrobbleFixture({
      artist_name: "Beyoncé de Prueba",
      album_name: "Señales синтетические",
      track_name: "雪のテスト — Café 🎧",
      recording_musicbrainz_id: "00000000-0000-4000-8000-000000000004",
    }),
  },
  {
    case: "time_boundary_before",
    record: buildLastfmScrobbleFixture({
      timestamp: epochMilliseconds(FIXTURE_TIMES.yearEnd),
      recording_musicbrainz_id: "00000000-0000-4000-8000-000000000005",
    }),
  },
  {
    case: "time_boundary_after",
    record: buildLastfmScrobbleFixture({
      timestamp: epochMilliseconds(FIXTURE_TIMES.yearStart),
      recording_musicbrainz_id: "00000000-0000-4000-8000-000000000006",
    }),
  },
  {
    case: "malformed",
    record: buildLastfmScrobbleFixture({ timestamp: "not-a-timestamp" }),
  },
] as const;

export const LASTFM_EXACT_DUPLICATE_FIXTURES = [
  buildLastfmScrobbleFixture({
    timestamp: epochMilliseconds("2026-02-03T04:01:59.789Z"),
    recording_musicbrainz_id: "00000000-0000-4000-8000-000000000007",
  }),
  buildLastfmScrobbleFixture({
    timestamp: epochMilliseconds("2026-02-03T04:01:59.789Z"),
    recording_musicbrainz_id: "00000000-0000-4000-8000-000000000007",
  }),
] as const;

export const LASTFM_AMBIGUOUS_OVERLAP_FIXTURE = buildLastfmScrobbleFixture({
  timestamp: epochMilliseconds(FIXTURE_TIMES.ambiguousLastfm),
  track_name: "Ambiguous Echo",
  artist_name: "The Synthetic Signals",
  album_name: null,
  release_musicbrainz_id: null,
  recording_musicbrainz_id: null,
});
