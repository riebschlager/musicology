import type {
  PublicDormancyStory,
  PublicRediscoveryStory,
  PublicStory,
  PublicStoryData,
} from "../adapters/public-snapshot.ts";
import { formatMonth, formatMonthRange, formatNumber, formatPercent } from "./site.ts";

const STORY_KINDS = ["all", "rediscovery", "dormancy"] as const;
const STORY_VIEWS = ["cards", "list"] as const;

export type StoryKindFilter = (typeof STORY_KINDS)[number];
export type StoryView = (typeof STORY_VIEWS)[number];

export interface StoryExplorerState {
  readonly canonicalSearch: string;
  readonly from: string | null;
  readonly kind: StoryKindFilter;
  readonly notice: string | null;
  readonly to: string | null;
  readonly view: StoryView;
}

export interface StoryExplorerBounds {
  readonly first: string;
  readonly last: string;
  readonly months: readonly string[];
}

export interface StoryEvidenceRow {
  readonly label: string;
  readonly value: string;
}

export interface StoryReference {
  readonly kindLabel: string;
  readonly slug: string;
  readonly title: string;
}

export interface StoryViewModel {
  readonly accessibilitySummary: string;
  readonly artistPath: string | null;
  readonly body: PublicStory["body"];
  readonly classificationExplanation: string;
  readonly classificationLabel: string;
  readonly evidenceRows: readonly StoryEvidenceRow[];
  readonly evidenceScopeLabel: string;
  readonly kind: PublicStory["kind"];
  readonly kindLabel: string;
  readonly parameterRows: readonly StoryEvidenceRow[];
  readonly period: string;
  readonly periodLabel: string;
  readonly relatedEraPath: string | null;
  readonly selectedTrackLabel: string | null;
  readonly slug: string;
  readonly summary: string;
  readonly supersededByStories: readonly StoryReference[];
  readonly supersedesStory: StoryReference | null;
  readonly title: string;
  readonly warnings: readonly string[];
}

export interface StoryExplorerModel {
  readonly bounds: StoryExplorerBounds | null;
  readonly findings: readonly string[];
  readonly rangeLabel: string;
  readonly stories: readonly StoryViewModel[];
}

interface StateValues {
  readonly from: string | null;
  readonly kind: StoryKindFilter;
  readonly to: string | null;
  readonly view: StoryView;
}

export const REDISCOVERY_CLASS_REGISTER = [
  {
    label: "One-off return",
    text: "A qualifying return appears, but the approved persistence window does not show a sustained pattern.",
  },
  {
    label: "Sustained rediscovery",
    text: "The return meets the published persistence threshold inside its approved observation window.",
  },
  {
    label: "Return beginning a new era",
    text: "The return is linked to a separately approved artist-era interval; the two classifications remain distinct evidence.",
  },
] as const;

export function parseStoryExplorerState(
  searchParams: URLSearchParams,
  stories: PublicStoryData["stories"],
): StoryExplorerState {
  const requestedKind = searchParams.get("kind");
  const requestedView = searchParams.get("view");
  const kind = isOneOf(requestedKind, STORY_KINDS) ? requestedKind : "all";
  const view = isOneOf(requestedView, STORY_VIEWS) ? requestedView : "cards";
  const range = normalizeRange(
    searchParams.get("from"),
    searchParams.get("to"),
    storyBounds(stories),
  );
  const invalid =
    [...searchParams.keys()].some(
      (key) => key !== "kind" && key !== "from" && key !== "to" && key !== "view",
    ) ||
    ["kind", "from", "to", "view"].some((key) => searchParams.getAll(key).length > 1) ||
    (requestedKind !== null && !isOneOf(requestedKind, STORY_KINDS)) ||
    (requestedView !== null && !isOneOf(requestedView, STORY_VIEWS)) ||
    range.invalid;
  const state = buildStoryExplorerState(stories, {
    from: invalid ? null : range.from,
    kind,
    to: invalid ? null : range.to,
    view,
  });

  return {
    ...state,
    notice: invalid
      ? "Unsupported or out-of-range link options were ignored; this index uses the nearest safe public default."
      : null,
  };
}

export function buildStoryExplorerState(
  stories: PublicStoryData["stories"],
  values: StateValues,
): StoryExplorerState {
  const bounds = storyBounds(stories);
  const range = normalizeRange(values.from, values.to, bounds);
  const canonical = new URLSearchParams();
  if (values.kind !== "all") canonical.set("kind", values.kind);
  if (bounds !== null && range.from !== null && range.from !== bounds.first) {
    canonical.set("from", range.from);
  }
  if (bounds !== null && range.to !== null && range.to !== bounds.last) {
    canonical.set("to", range.to);
  }
  if (values.view !== "cards") canonical.set("view", values.view);

  return {
    canonicalSearch: canonical.size === 0 ? "" : `?${canonical.toString()}`,
    from: range.from,
    kind: values.kind,
    notice: null,
    to: range.to,
    view: values.view,
  };
}

export function buildStoryExplorerModel(
  data: PublicStoryData,
  state: StoryExplorerState,
  asOfDate: string | null,
): StoryExplorerModel {
  const selected = data.stories
    .filter((story) => state.kind === "all" || story.kind === state.kind)
    .filter((story) => {
      const period = storyPeriod(story);
      return (
        (state.from === null || period >= state.from) && (state.to === null || period <= state.to)
      );
    });
  const stories = selected.map((story) => buildStoryViewModel(story, data.stories, asOfDate));
  const superseded = stories.filter((story) => story.supersededByStories.length > 0).length;
  const openReturns = selected.filter(
    (story) => story.kind === "rediscovery" && story.evidence.persistence === "open",
  ).length;

  return {
    bounds: storyBounds(data.stories),
    findings:
      stories.length === 0
        ? [
            "No reviewed story matches this bounded public selection. Unreviewed analytical candidates are never substituted.",
          ]
        : [
            `${formatNumber(stories.length)} reviewed ${stories.length === 1 ? "story is" : "stories are"} shown in editorial order; this is not an automatically ranked candidate feed.`,
            openReturns === 0
              ? "Every displayed return has a closed published persistence reading, while later listening can still change the larger interpretation."
              : `${formatNumber(openReturns)} displayed ${openReturns === 1 ? "return has" : "returns have"} an open persistence window and is not treated as a settled rediscovery.`,
            superseded === 0
              ? "No displayed conclusion is superseded by another approved story in this snapshot."
              : `${formatNumber(superseded)} earlier ${superseded === 1 ? "conclusion is" : "conclusions are"} visibly superseded by later approved context rather than silently rewritten.`,
          ],
    rangeLabel:
      state.from === null || state.to === null
        ? "no reviewed period"
        : `${formatMonth(state.from)}–${formatMonth(state.to)}`,
    stories,
  };
}

export function buildStoryViewModel(
  story: PublicStory,
  allStories: PublicStoryData["stories"],
  asOfDate: string | null,
): StoryViewModel {
  const supersedes =
    story.supersedesStorySlug === null
      ? null
      : (allStories.find((candidate) => candidate.slug === story.supersedesStorySlug) ?? null);
  const supersededBy = allStories.filter(
    (candidate) => candidate.supersedesStorySlug === story.slug,
  );
  const common = {
    accessibilitySummary: story.accessibilitySummary,
    artistPath: story.artistSlug === null ? null : `/artists/${story.artistSlug}/`,
    body: story.body,
    kind: story.kind,
    kindLabel: story.kind === "rediscovery" ? "Return story" : "Dormancy observation",
    period: storyPeriod(story),
    periodLabel: formatMonth(storyPeriod(story)),
    selectedTrackLabel:
      story.selectedTrack === null
        ? null
        : `${story.selectedTrack.artistDisplayName} — ${story.selectedTrack.trackDisplayName}`,
    slug: story.slug,
    summary: story.summary,
    supersededByStories: supersededBy.map(storyReference),
    supersedesStory: supersedes === null ? null : storyReference(supersedes),
    title: story.title,
  } as const;

  return story.kind === "rediscovery"
    ? {
        ...common,
        classificationExplanation: rediscoveryExplanation(story.evidence.classification),
        classificationLabel: rediscoveryLabel(story.evidence.classification),
        evidenceRows: rediscoveryEvidenceRows(story),
        evidenceScopeLabel:
          story.parameters.scope === "artist"
            ? "Artist-level return evidence"
            : "Track-level return evidence",
        parameterRows: rediscoveryParameterRows(story),
        relatedEraPath: relatedEraPath(story),
        warnings: rediscoveryWarnings(story, supersededBy, supersedes),
      }
    : {
        ...common,
        classificationExplanation:
          "A bounded, reversible observation made only through the snapshot's as-of date.",
        classificationLabel:
          story.evidence.status === "dormant"
            ? `Dormant as of ${asOfDate ?? "the published as-of date"}`
            : `Likely dormant as of ${asOfDate ?? "the published as-of date"}`,
        evidenceRows: dormancyEvidenceRows(story, asOfDate),
        evidenceScopeLabel: "Eligible artist-level dormancy evidence",
        parameterRows: dormancyParameterRows(story),
        relatedEraPath: null,
        warnings: dormancyWarnings(asOfDate, supersededBy, supersedes),
      };
}

function rediscoveryEvidenceRows(story: PublicRediscoveryStory): readonly StoryEvidenceRow[] {
  const { evidence, parameters } = story;
  return [
    { label: "Classification", value: rediscoveryLabel(evidence.classification) },
    { label: "Prior listen (reduced date)", value: formatMonth(evidence.priorPeriod) },
    { label: "Prior meaningful plays", value: formatNumber(evidence.priorPlayCount) },
    { label: "Observed absence gap", value: `${formatNumber(evidence.gapDays)} days` },
    { label: "Return month", value: formatMonth(evidence.returnPeriod) },
    {
      label: "Return intensity",
      value: `${formatNumber(evidence.returnIntensity)} plays in ${formatNumber(parameters.returnWindowDays)} days`,
    },
    {
      label: "Persistence",
      value: `${persistenceLabel(evidence.persistence)} · ${formatNumber(evidence.persistencePlayCount)} plays in ${formatNumber(parameters.persistenceWindowDays)} days`,
    },
    {
      label: "Return window",
      value: evidence.returnWindowComplete
        ? "Complete at publication"
        : "Still open at publication",
    },
    {
      label: "Related era",
      value:
        evidence.relatedEra === null
          ? "No related public era"
          : formatMonthRange(
              evidence.relatedEra.startPeriod,
              evidence.relatedEra.endPeriodExclusive,
            ),
    },
  ];
}

function rediscoveryParameterRows(story: PublicRediscoveryStory): readonly StoryEvidenceRow[] {
  const parameters = story.parameters;
  return [
    { label: "Evidence scope", value: parameters.scope === "artist" ? "Artist" : "Track" },
    { label: "Absence threshold", value: `${formatNumber(parameters.absenceThresholdDays)} days` },
    { label: "Minimum prior plays", value: formatNumber(parameters.minimumPriorPlayCount) },
    { label: "Minimum return plays", value: formatNumber(parameters.minimumReturnPlayCount) },
    { label: "Return window", value: `${formatNumber(parameters.returnWindowDays)} days` },
    {
      label: "Minimum persistence plays",
      value: formatNumber(parameters.minimumPersistencePlayCount),
    },
    {
      label: "Persistence window",
      value: `${formatNumber(parameters.persistenceWindowDays)} days`,
    },
  ];
}

function dormancyEvidenceRows(
  story: PublicDormancyStory,
  asOfDate: string | null,
): readonly StoryEvidenceRow[] {
  const { evidence, parameters } = story;
  return [
    {
      label: "Observation status",
      value:
        evidence.status === "dormant"
          ? `Dormant as of ${asOfDate ?? "the published as-of date"}`
          : `Likely dormant as of ${asOfDate ?? "the published as-of date"}`,
    },
    { label: "Last listen (reduced date)", value: formatMonth(evidence.lastListenPeriod) },
    {
      label: "Last active period",
      value: `${formatMonth(evidence.lastActivePeriod.startPeriod)}–${formatMonth(evidence.lastActivePeriod.endPeriod)}`,
    },
    {
      label: "Last active-period plays",
      value: formatNumber(evidence.lastActivePeriod.playCount),
    },
    { label: "Historical plays", value: formatNumber(evidence.historicalPlayCount) },
    { label: "Prior active periods", value: formatNumber(evidence.activePeriodCount) },
    {
      label: "Former cadence",
      value: `${formatNumber(evidence.formerCadencePlayCount)} plays / ${formatNumber(parameters.formerCadenceWindowDays)} days (${formatNumber(evidence.formerCadencePlaysPer30Days)} per 30 days)`,
    },
    {
      label: "Observed after last listen",
      value: `${formatNumber(evidence.observationDays)} days`,
    },
    { label: "Overall confidence", value: formatPercent(evidence.confidence.score) },
    {
      label: "Historical-importance confidence",
      value: formatPercent(evidence.confidence.historicalImportance),
    },
    { label: "Former-cadence confidence", value: formatPercent(evidence.confidence.formerCadence) },
    {
      label: "Observation-completeness confidence",
      value: formatPercent(evidence.confidence.observationCompleteness),
    },
  ];
}

function dormancyParameterRows(story: PublicDormancyStory): readonly StoryEvidenceRow[] {
  const parameters = story.parameters;
  return [
    { label: "Active-period gap", value: `${formatNumber(parameters.activePeriodGapDays)} days` },
    { label: "Dormancy threshold", value: `${formatNumber(parameters.dormancyDays)} days` },
    {
      label: "Likely-dormant threshold",
      value: `${formatNumber(parameters.likelyAbandonedDays)} days`,
    },
    {
      label: "Observation window required",
      value: `${formatNumber(parameters.observationWindowDays)} days`,
    },
    {
      label: "Former-cadence window",
      value: `${formatNumber(parameters.formerCadenceWindowDays)} days`,
    },
    {
      label: "Minimum former-cadence plays",
      value: formatNumber(parameters.minimumFormerCadencePlayCount),
    },
    {
      label: "Minimum historical plays",
      value: formatNumber(parameters.minimumHistoricalPlayCount),
    },
  ];
}

function rediscoveryWarnings(
  story: PublicRediscoveryStory,
  supersededBy: readonly PublicStory[],
  supersedes: PublicStory | null,
): readonly string[] {
  return [
    "The gap is measured in retained evidence. A documented source gap can resemble an absence, so it is not proof that listening stopped.",
    ...(story.evidence.persistence === "open" || !story.evidence.returnWindowComplete
      ? [
          "The return or persistence window was still open at publication; its class can change in a later approved snapshot.",
        ]
      : []),
    ...supersessionWarnings(supersededBy, supersedes),
    ...(story.selectedTrack === null
      ? []
      : [
          "The displayed track identity is wholly manual reviewed editorial detail. It does not create track-level analytical evidence or a play history.",
        ]),
  ];
}

function dormancyWarnings(
  asOfDate: string | null,
  supersededBy: readonly PublicStory[],
  supersedes: PublicStory | null,
): readonly string[] {
  return [
    `This is a reversible observation bounded by ${asOfDate ?? "the published as-of date"}. The archive cannot observe future listening, so the conclusion is right-censored and never permanent.`,
    "Source coverage can make apparent inactivity less certain; the published confidence components and observation window qualify the label.",
    ...supersessionWarnings(supersededBy, supersedes),
  ];
}

function supersessionWarnings(
  supersededBy: readonly PublicStory[],
  supersedes: PublicStory | null,
): readonly string[] {
  return [
    ...(supersededBy.length === 0
      ? []
      : [
          "Later approved context supersedes this conclusion. It remains visible as historical interpretation rather than being silently rewritten.",
        ]),
    ...(supersedes === null
      ? []
      : [
          "This approved story supersedes an older conclusion while preserving the earlier record and its original evidence.",
        ]),
  ];
}

function relatedEraPath(story: PublicRediscoveryStory): string | null {
  if (story.artistSlug === null || story.evidence.relatedEra === null) return null;
  const params = new URLSearchParams();
  params.set("from", story.evidence.relatedEra.startPeriod);
  params.set("to", previousMonth(story.evidence.relatedEra.endPeriodExclusive));
  params.set("artist", story.artistSlug);
  params.set("view", "table");
  return `/artists/?${params.toString()}`;
}

function storyReference(story: PublicStory): StoryReference {
  return {
    kindLabel: story.kind === "rediscovery" ? "Return story" : "Dormancy observation",
    slug: story.slug,
    title: story.title,
  };
}

function storyPeriod(story: PublicStory): string {
  return story.kind === "rediscovery"
    ? story.evidence.returnPeriod
    : story.evidence.lastListenPeriod;
}

function storyBounds(stories: PublicStoryData["stories"]): StoryExplorerBounds | null {
  const periods = stories.map(storyPeriod).toSorted();
  const first = periods[0];
  const last = periods.at(-1);
  if (first === undefined || last === undefined) return null;
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

function normalizeRange(
  requestedFrom: string | null,
  requestedTo: string | null,
  bounds: StoryExplorerBounds | null,
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

function rediscoveryLabel(
  classification: PublicRediscoveryStory["evidence"]["classification"],
): string {
  if (classification === "one_off_return") return "One-off return";
  if (classification === "return_beginning_new_era") return "Return beginning a new era";
  return "Sustained rediscovery";
}

function rediscoveryExplanation(
  classification: PublicRediscoveryStory["evidence"]["classification"],
): string {
  if (classification === "one_off_return") {
    return "A qualifying return appears, but the approved persistence evidence does not establish a sustained pattern.";
  }
  if (classification === "return_beginning_new_era") {
    return "The return is linked to a separately approved artist-era interval; neither signal creates the other.";
  }
  return "The return meets the published persistence threshold inside its approved observation window.";
}

function persistenceLabel(value: PublicRediscoveryStory["evidence"]["persistence"]): string {
  if (value === "open") return "Observation still open";
  if (value === "persistent") return "Persistent in the published window";
  return "Not persistent in the published window";
}

function previousMonth(month: string): string {
  return monthFromOrdinal(monthOrdinal(month) - 1);
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
