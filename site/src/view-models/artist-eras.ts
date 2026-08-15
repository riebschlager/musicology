import type { PublicArtistComponents, PublicArtistData } from "../adapters/public-snapshot.ts";
import { formatMonth, formatMonthRange, formatNumber, formatPercent } from "./site.ts";

const INDEX_VIEWS = ["timeline", "table"] as const;
const DETAIL_VIEWS = ["summary", "components", "table"] as const;
export const MAX_ARTIST_COMPARISON = 5;

export type ArtistEraView = (typeof INDEX_VIEWS)[number];
export type ArtistDetailView = (typeof DETAIL_VIEWS)[number];

export interface ArtistEraState {
  readonly artistSlugs: readonly string[];
  readonly canonicalSearch: string;
  readonly from: string | null;
  readonly notice: string | null;
  readonly to: string | null;
  readonly view: ArtistEraView;
}

export interface ArtistDetailState {
  readonly canonicalSearch: string;
  readonly from: string | null;
  readonly notice: string | null;
  readonly to: string | null;
  readonly view: ArtistDetailView;
}

export interface ArtistEraRow {
  readonly artistDisplayName: string;
  readonly artistSlug: string;
  readonly endPeriodExclusive: string;
  readonly evidence: readonly ArtistEvidenceRow[];
  readonly overlapCount: number;
  readonly peak: PublicArtistData["artists"][number]["intervals"][number]["peak"];
  readonly playCount: number;
  readonly share: number;
  readonly startPeriod: string;
  readonly strength: number;
}

export interface ArtistEvidenceRow {
  readonly artistDisplayName: string;
  readonly artistSlug: string;
  readonly components: PublicArtistComponents;
  readonly intervalLabel: string;
  readonly period: string;
}

export interface ArtistEraModel {
  readonly bounds: ArtistEraBounds | null;
  readonly evidenceRows: readonly ArtistEvidenceRow[];
  readonly findings: readonly string[];
  readonly rangeLabel: string;
  readonly rows: readonly ArtistEraRow[];
  readonly selectedArtistCount: number;
}

export interface ArtistDetailModel {
  readonly evidenceRows: readonly ArtistEvidenceRow[];
  readonly findings: readonly string[];
  readonly intervalRows: readonly ArtistEraRow[];
  readonly rangeLabel: string;
}

export interface ArtistEraBounds {
  readonly first: string;
  readonly last: string;
  readonly months: readonly string[];
}

interface StateValues<TView extends string> {
  readonly from: string | null;
  readonly to: string | null;
  readonly view: TView;
}

export function parseArtistEraState(
  searchParams: URLSearchParams,
  artists: PublicArtistData["artists"],
): ArtistEraState {
  const publicSlugs = new Set(artists.map((artist) => artist.slug));
  const requestedSlugs = searchParams.getAll("artist");
  const uniqueSlugs = [...new Set(requestedSlugs)];
  const invalidArtists =
    requestedSlugs.length !== uniqueSlugs.length ||
    uniqueSlugs.length > MAX_ARTIST_COMPARISON ||
    uniqueSlugs.some((slug) => !publicSlugs.has(slug));
  const orderedSlugs = invalidArtists
    ? []
    : artists.filter((artist) => uniqueSlugs.includes(artist.slug)).map((artist) => artist.slug);
  const parsed = parseRangeAndView(searchParams, artistBounds(artists), INDEX_VIEWS, "timeline", [
    "artist",
    "from",
    "to",
    "view",
  ]);
  const state = buildArtistEraState(artists, {
    artistSlugs: orderedSlugs,
    from: parsed.values.from,
    to: parsed.values.to,
    view: parsed.values.view,
  });

  return {
    ...state,
    notice:
      invalidArtists || parsed.invalid
        ? "Unsupported, duplicate, or out-of-range link options were ignored; this view uses the nearest safe public default."
        : null,
  };
}

export function buildArtistEraState(
  artists: PublicArtistData["artists"],
  values: StateValues<ArtistEraView> & { readonly artistSlugs: readonly string[] },
): ArtistEraState {
  const bounds = artistBounds(artists);
  const range = normalizeRange(values.from, values.to, bounds);
  const publicSlugs = new Set(artists.map((artist) => artist.slug));
  const artistSlugs = artists
    .filter((artist) => values.artistSlugs.includes(artist.slug))
    .map((artist) => artist.slug)
    .filter((slug, index, selected) => publicSlugs.has(slug) && selected.indexOf(slug) === index)
    .slice(0, MAX_ARTIST_COMPARISON);
  const canonical = new URLSearchParams();
  if (bounds !== null && range.from !== null && range.from !== bounds.first) {
    canonical.set("from", range.from);
  }
  if (bounds !== null && range.to !== null && range.to !== bounds.last) {
    canonical.set("to", range.to);
  }
  for (const slug of artistSlugs) canonical.append("artist", slug);
  if (values.view !== "timeline") canonical.set("view", values.view);

  return {
    artistSlugs,
    canonicalSearch: canonical.size === 0 ? "" : `?${canonical.toString()}`,
    from: range.from,
    notice: null,
    to: range.to,
    view: values.view,
  };
}

export function parseArtistDetailState(
  searchParams: URLSearchParams,
  artist: PublicArtistData["artists"][number],
): ArtistDetailState {
  const parsed = parseRangeAndView(searchParams, artistBounds([artist]), DETAIL_VIEWS, "summary", [
    "from",
    "to",
    "view",
  ]);
  const state = buildArtistDetailState(artist, parsed.values);
  return {
    ...state,
    notice: parsed.invalid
      ? "Unsupported or out-of-range link options were ignored; this artist page uses its nearest safe public default."
      : null,
  };
}

export function buildArtistDetailState(
  artist: PublicArtistData["artists"][number],
  values: StateValues<ArtistDetailView>,
): ArtistDetailState {
  const bounds = artistBounds([artist]);
  const range = normalizeRange(values.from, values.to, bounds);
  const canonical = new URLSearchParams();
  if (bounds !== null && range.from !== null && range.from !== bounds.first) {
    canonical.set("from", range.from);
  }
  if (bounds !== null && range.to !== null && range.to !== bounds.last) {
    canonical.set("to", range.to);
  }
  if (values.view !== "summary") canonical.set("view", values.view);
  return {
    canonicalSearch: canonical.size === 0 ? "" : `?${canonical.toString()}`,
    from: range.from,
    notice: null,
    to: range.to,
    view: values.view,
  };
}

export function buildArtistEraModel(data: PublicArtistData, state: ArtistEraState): ArtistEraModel {
  const selected =
    state.artistSlugs.length === 0
      ? data.artists
      : data.artists.filter((artist) => state.artistSlugs.includes(artist.slug));
  const rows = buildRows(selected, state.from, state.to);
  const evidenceRows = rows.flatMap((row) => row.evidence);
  const overlapRows = rows.filter((row) => row.overlapCount > 0);
  const sparseRows = rows.filter((row) => row.evidence.length <= 2);
  const rangeLabel = formatSelectedRange(state.from, state.to);
  const findings =
    rows.length === 0
      ? [
          "No eligible public interval intersects this selection. The view does not reveal suppressed artist names or counts.",
        ]
      : [
          `${formatNumber(rows.length)} qualifying interval${rows.length === 1 ? "" : "s"} from ${formatNumber(selected.length)} eligible artist${selected.length === 1 ? "" : "s"} intersect ${rangeLabel}. Inclusion is a publication threshold, not a permanent favorite label.`,
          overlapRows.length === 0
            ? "No displayed intervals overlap in this selection; another range or eligible comparison can still reveal concurrent signals."
            : `${formatNumber(overlapRows.length)} displayed interval${overlapRows.length === 1 ? "" : "s"} overlap at least one other signal. Overlap is retained rather than forcing the history into one-artist chapters.`,
          sparseRows.length === 0
            ? "Every displayed interval has more than two approved evidence windows."
            : `${formatNumber(sparseRows.length)} displayed interval${sparseRows.length === 1 ? " has" : "s have"} only one or two approved evidence windows. ${sparseRows.length === 1 ? "It remains" : "They remain"} visible with that qualification because the public contract already admitted the aggregate interval.`,
          `Strength and interval bounds use the published ${formatNumber(data.parameters.rollingWindowCount ?? 0)}-window rolling rule. Range selection chooses intersecting intervals; their bounds, totals, peaks, and complete component evidence remain reconciled and whole.`,
        ];

  return {
    bounds: artistBounds(data.artists),
    evidenceRows,
    findings,
    rangeLabel,
    rows,
    selectedArtistCount: selected.length,
  };
}

export function buildArtistDetailModel(
  artist: PublicArtistData["artists"][number],
  state: ArtistDetailState,
): ArtistDetailModel {
  const intervalRows = buildRows([artist], state.from, state.to);
  const evidenceRows = intervalRows.flatMap((row) => row.evidence);
  const rangeLabel = formatSelectedRange(state.from, state.to);
  const strongest = intervalRows.toSorted((left, right) => right.strength - left.strength)[0];
  return {
    evidenceRows,
    findings:
      strongest === undefined
        ? [
            `No approved interval for ${artist.displayName} intersects ${rangeLabel}. No individual plays are substituted.`,
          ]
        : [
            `${formatNumber(intervalRows.length)} qualifying interval${intervalRows.length === 1 ? "" : "s"} intersect ${rangeLabel}. The strongest peaks in ${formatMonth(strongest.peak.period)} at ${formatPercent(strongest.strength)} strength.`,
            `${formatNumber(evidenceRows.length)} aggregate evidence window${evidenceRows.length === 1 ? "" : "s"} belong to the intervals intersecting ${rangeLabel}. Complete interval evidence stays together so its totals and peak reconcile; the rows are not individual listens or an event log.`,
            "Eligibility means at least one aggregate interval met the publication gates. It does not make the artist a permanent favorite or reveal the suppressed artist catalog.",
          ],
    intervalRows,
    rangeLabel,
  };
}

export function formatComponentValue(
  field: keyof PublicArtistComponents,
  value: number | null,
): string {
  if (value === null) return "No earlier baseline";
  if (field === "listeningShare" || field === "strength") return formatPercent(value);
  if (field === "earlierBaselineChange" && value > 0) return `+${formatNumber(value)}`;
  return formatNumber(value);
}

export function previousMonth(endPeriodExclusive: string): string {
  const ordinal = monthOrdinal(endPeriodExclusive) - 1;
  return monthFromOrdinal(ordinal);
}

function buildRows(
  artists: PublicArtistData["artists"],
  from: string | null,
  to: string | null,
): readonly ArtistEraRow[] {
  const base = artists.flatMap((artist) =>
    artist.intervals
      .filter(
        (interval) =>
          (from === null || interval.endPeriodExclusive > from) &&
          (to === null || interval.startPeriod <= to),
      )
      .map((interval) => ({ artist, interval })),
  );

  return base
    .map(({ artist, interval }, index) => ({
      artistDisplayName: artist.displayName,
      artistSlug: artist.slug,
      endPeriodExclusive: interval.endPeriodExclusive,
      evidence: interval.evidence.map((evidence) => ({
        artistDisplayName: artist.displayName,
        artistSlug: artist.slug,
        components: evidence.components,
        intervalLabel: formatMonthRange(interval.startPeriod, interval.endPeriodExclusive),
        period: evidence.period,
      })),
      overlapCount: base.filter(
        ({ interval: candidate }, candidateIndex) =>
          candidateIndex !== index &&
          interval.startPeriod < candidate.endPeriodExclusive &&
          candidate.startPeriod < interval.endPeriodExclusive,
      ).length,
      peak: interval.peak,
      playCount: interval.playCount,
      share: interval.share,
      startPeriod: interval.startPeriod,
      strength: interval.strength,
    }))
    .toSorted(
      (left, right) =>
        left.startPeriod.localeCompare(right.startPeriod) ||
        left.artistDisplayName.localeCompare(right.artistDisplayName) ||
        left.endPeriodExclusive.localeCompare(right.endPeriodExclusive),
    );
}

function parseRangeAndView<TView extends string>(
  searchParams: URLSearchParams,
  bounds: ArtistEraBounds | null,
  views: readonly TView[],
  defaultView: TView,
  allowedKeys: readonly string[],
): { readonly invalid: boolean; readonly values: StateValues<TView> } {
  const requestedFrom = searchParams.get("from");
  const requestedTo = searchParams.get("to");
  const requestedView = searchParams.get("view");
  const view = isOneOf(requestedView, views) ? requestedView : defaultView;
  const range = normalizeRange(requestedFrom, requestedTo, bounds);
  const repeatedSingleton = ["from", "to", "view"].some(
    (key) => searchParams.getAll(key).length > 1,
  );
  const unsupported = [...searchParams.keys()].some((key) => !allowedKeys.includes(key));
  const invalid =
    repeatedSingleton ||
    unsupported ||
    range.invalid ||
    (requestedView !== null && !isOneOf(requestedView, views));
  return {
    invalid,
    values: {
      from: invalid ? (bounds?.first ?? null) : range.from,
      to: invalid ? (bounds?.last ?? null) : range.to,
      view,
    },
  };
}

function normalizeRange(
  requestedFrom: string | null,
  requestedTo: string | null,
  bounds: ArtistEraBounds | null,
): { readonly from: string | null; readonly invalid: boolean; readonly to: string | null } {
  if (bounds === null) {
    return {
      from: null,
      invalid: requestedFrom !== null || requestedTo !== null,
      to: null,
    };
  }
  const from = requestedFrom ?? bounds.first;
  const to = requestedTo ?? bounds.last;
  const invalid =
    !isMonth(from) || !isMonth(to) || from < bounds.first || to > bounds.last || from > to;
  return {
    from: invalid ? bounds.first : from,
    invalid,
    to: invalid ? bounds.last : to,
  };
}

function artistBounds(artists: PublicArtistData["artists"]): ArtistEraBounds | null {
  const intervals = artists.flatMap((artist) => artist.intervals);
  const first = intervals.map((interval) => interval.startPeriod).toSorted()[0];
  const lastExclusive = intervals
    .map((interval) => interval.endPeriodExclusive)
    .toSorted()
    .at(-1);
  if (first === undefined || lastExclusive === undefined) return null;
  const last = previousMonth(lastExclusive);
  const firstOrdinal = monthOrdinal(first);
  const lastOrdinal = monthOrdinal(last);
  return {
    first,
    last,
    months: Array.from({ length: lastOrdinal - firstOrdinal + 1 }, (_, index) =>
      monthFromOrdinal(firstOrdinal + index),
    ),
  };
}

function formatSelectedRange(from: string | null, to: string | null): string {
  if (from === null || to === null) return "no reviewed period";
  return `${formatMonth(from)}–${formatMonth(to)}`;
}

function monthOrdinal(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return (year ?? 0) * 12 + (monthNumber ?? 1) - 1;
}

function monthFromOrdinal(ordinal: number): string {
  const year = Math.floor(ordinal / 12);
  const month = (ordinal % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function isMonth(value: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value);
}

function isOneOf<T extends string>(value: string | null, choices: readonly T[]): value is T {
  return value !== null && choices.some((choice) => choice === value);
}
