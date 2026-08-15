import type { SiteSnapshot } from "../adapters/public-snapshot.ts";

const GRAINS = ["month", "quarter", "year"] as const;
const VIEWS = ["chart", "table"] as const;

export type ExplorerGrain = (typeof GRAINS)[number];
export type ExplorerView = (typeof VIEWS)[number];

export interface ExplorerState {
  readonly canonicalSearch: string;
  readonly grain: ExplorerGrain;
  readonly notice: string | null;
  readonly view: ExplorerView;
}

export interface AnalyticalDisclosure {
  readonly asOfLabel: string;
  readonly durationScope: string;
  readonly genreStatus: string;
  readonly metricDefinition: string;
  readonly parameters: readonly { readonly label: string; readonly value: string }[];
  readonly publicationLabel: string;
  readonly sourceGapSummary: string;
  readonly timezone: string;
  readonly unresolvedSummary: string;
  readonly versionSummary: string;
}

export interface StoryCard {
  readonly kind: "dormancy" | "rediscovery";
  readonly summary: string;
  readonly title: string;
  readonly trackLabel?: string;
}

export function parseExplorerState(searchParams: URLSearchParams): ExplorerState {
  const requestedGrain = searchParams.get("grain");
  const requestedView = searchParams.get("view");
  const grain = isOneOf(requestedGrain, GRAINS) ? requestedGrain : "month";
  const view = isOneOf(requestedView, VIEWS) ? requestedView : "chart";
  const unsupported = [...searchParams.keys()].some((key) => key !== "grain" && key !== "view");
  const invalid =
    (requestedGrain !== null && !isOneOf(requestedGrain, GRAINS)) ||
    (requestedView !== null && !isOneOf(requestedView, VIEWS));
  return {
    ...buildExplorerState(grain, view),
    notice:
      invalid || unsupported
        ? "Unsupported link options were ignored; this page is showing the nearest public default."
        : null,
  };
}

export function buildExplorerState(grain: ExplorerGrain, view: ExplorerView): ExplorerState {
  const canonical = new URLSearchParams();
  if (grain !== "month") canonical.set("grain", grain);
  if (view !== "chart") canonical.set("view", view);

  return {
    canonicalSearch: canonical.size === 0 ? "" : `?${canonical.toString()}`,
    grain,
    notice: null,
    view,
  };
}

export function buildStoryCards(
  stories: SiteSnapshot["stories"]["data"]["stories"],
): readonly StoryCard[] {
  return stories.map((story) => ({
    kind: story.kind,
    summary: story.summary,
    title: story.title,
    ...(story.selectedTrack === null
      ? {}
      : {
          trackLabel: `${story.selectedTrack.artistDisplayName} — ${story.selectedTrack.trackDisplayName}`,
        }),
  }));
}

export function buildAnalyticalDisclosure(snapshot: SiteSnapshot): AnalyticalDisclosure {
  const { coverage } = snapshot.manifest;
  const gaps = snapshot.history.data.sourceCoverage.flatMap((source) =>
    source.longGaps.map(
      (gap) =>
        `${sourceLabel(source.source)}: ${gap.afterPeriod} to ${gap.beforePeriod} (${formatNumber(gap.durationDays)} days)`,
    ),
  );
  const durationShare =
    coverage.canonicalEventCount === 0
      ? 0
      : coverage.spotifyDurationEventCount / coverage.canonicalEventCount;

  return {
    asOfLabel: snapshot.manifest.asOfDate ?? "No analytical as-of date",
    durationScope:
      coverage.canonicalEventCount === 0
        ? "No Spotify-backed duration observations are present in this reviewed snapshot."
        : `${formatNumber(coverage.spotifyDurationEventCount)} of ${formatNumber(coverage.canonicalEventCount)} canonical events (${formatPercent(durationShare)}) have Spotify-backed duration. Duration never represents the full history.`,
    genreStatus:
      snapshot.manifest.artifacts.genreLab === null
        ? "Genre evidence is not included in this snapshot; no partial genre history is presented as complete."
        : "Genre results are experimental and must disclose provider, mode, weighting, freshness, and usable-event coverage.",
    metricDefinition: snapshot.history.data.metricDefinition,
    parameters: [
      {
        label: "History grain",
        value: snapshot.history.data.grain,
      },
      {
        label: "Rolling window",
        value: `${formatNumber(snapshot.history.data.parameters.rollingWindowPeriods)} period`,
      },
      {
        label: "Unresolved events",
        value: snapshot.history.data.parameters.includeUnresolved ? "included" : "excluded",
      },
    ],
    publicationLabel:
      snapshot.manifest.publicationDate === null
        ? "Deterministic review fixture — not a published snapshot"
        : snapshot.manifest.publicationDate,
    sourceGapSummary:
      gaps.length === 0
        ? "No source gap is listed in this snapshot. Evidence coverage still differs by source and period."
        : `Documented source gaps: ${gaps.join("; ")}. A source gap is not proof that listening stopped.`,
    timezone: snapshot.manifest.timezone,
    unresolvedSummary: `${formatPercent(coverage.unresolvedRate)} of canonical events remain unresolved. They stay in full-history play counts unless a metric says otherwise.`,
    versionSummary: snapshot.manifest.analyticalVersions
      .map((version) => `${version.analysis} ${version.analysisVersion}`)
      .join(" · "),
  };
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

export function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(value);
}

export function formatMonth(value: string): string {
  const [year, month] = value.split("-").map(Number);
  if (year === undefined || month === undefined) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function formatMonthRange(startPeriod: string, endPeriodExclusive: string): string {
  const [endYear, endMonth] = endPeriodExclusive.split("-").map(Number);
  if (endYear === undefined || endMonth === undefined) {
    return `${formatMonth(startPeriod)}–${formatMonth(endPeriodExclusive)}`;
  }
  const inclusiveEnd = new Date(Date.UTC(endYear, endMonth - 2, 1));
  const inclusiveEndPeriod = `${inclusiveEnd.getUTCFullYear()}-${String(inclusiveEnd.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${formatMonth(startPeriod)}–${formatMonth(inclusiveEndPeriod)}`;
}

function sourceLabel(source: "lastfm" | "spotify"): string {
  return source === "lastfm" ? "Last.fm" : "Spotify";
}

function isOneOf<T extends string>(value: string | null, choices: readonly T[]): value is T {
  return value !== null && choices.some((choice) => choice === value);
}
