export const FIXTURE_TIMES = {
  ambiguousLastfm: "2026-01-15T12:00:00.000Z",
  ambiguousSpotifyFirstStop: "2026-01-15T12:03:00.000Z",
  ambiguousSpotifySecondStop: "2026-01-15T12:03:02.000Z",
  chicagoDstBefore: "2024-03-10T07:59:59.999Z",
  chicagoDstAfter: "2024-03-10T08:00:00.000Z",
  yearEnd: "2025-12-31T23:59:59.999Z",
  yearStart: "2026-01-01T00:00:00.000Z",
} as const;

export function epochMilliseconds(instant: string): number {
  return Date.parse(instant);
}
