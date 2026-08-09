export const PUBLIC_SELECTION_POLICY_VERSION = "public-selection-policy-v1";

export const PUBLIC_SELECTION_POLICY = {
  artistEligibility: {
    maximumArtists: 200,
    maximumEvidenceWindowsPerInterval: 48,
    maximumIntervalsPerArtist: 12,
    minimumPeakStrength: 0.75,
    minimumQualifyingIntervalPlayCount: 24,
  },
  dateGranularity: {
    analytical: "month",
    coverage: "year",
    operational: "day",
  },
  genreEligibility: {
    minimumIntervalContribution: 24,
    minimumPeakStrength: 0.75,
  },
  resultLimits: {
    maximumAnnotations: 100,
    maximumFeaturedArtists: 40,
    maximumGenreIntervals: 300,
    maximumGenres: 100,
    maximumHistoryMonths: 600,
    maximumStories: 40,
  },
  selectedTracks: {
    maximumPerStory: 1,
    mode: "manual_allowlist_only",
  },
} as const;

const PUBLIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CANONICAL_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface PublicArtistSelectionCandidate {
  readonly displayName: string;
  readonly intervals: readonly {
    readonly playCount: number;
    readonly strength: number;
  }[];
  readonly slug: string;
}

export interface SelectedTrackCandidate {
  readonly artistDisplayName: string;
  readonly selectionKey: string;
  readonly trackDisplayName: string;
}

export interface SelectedTrackAllowlistEntry {
  readonly selectionKey: string;
  readonly storySlug: string;
  readonly trackSlug: string;
}

export interface PublicSelectedTrackDetail {
  readonly artistDisplayName: string;
  readonly slug: string;
  readonly storySlug: string;
  readonly trackDisplayName: string;
}

export class PublicationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationPolicyError";
  }
}

export function assertPublicSlug(value: unknown, label = "Public slug"): asserts value is string {
  if (typeof value !== "string" || value.length > 80 || !PUBLIC_SLUG_PATTERN.test(value)) {
    throw new PublicationPolicyError(
      `${label} must be 1-80 lowercase ASCII letters, numbers, or single hyphen separators`,
    );
  }
}

export function reduceAnalyticalTimestampToMonth(
  value: unknown,
  presentationTimezone: unknown,
): string {
  const timestamp = validateCanonicalUtcTimestamp(value, "Analytical timestamp");
  const timezone = validatePresentationTimezone(presentationTimezone);
  const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(Date.parse(timestamp));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (year === undefined || month === undefined) {
    throw new PublicationPolicyError("Analytical timestamp could not be reduced to a public month");
  }
  return `${year}-${month}`;
}

export function reduceOperationalTimestampToDate(value: unknown): string {
  const timestamp = validateCanonicalUtcTimestamp(value, "Operational timestamp");
  return timestamp.slice(0, 10);
}

export function isPublicArtistEligible(candidate: PublicArtistSelectionCandidate): boolean {
  validateArtistCandidate(candidate);
  return candidate.intervals.some(
    (interval) =>
      interval.playCount >=
        PUBLIC_SELECTION_POLICY.artistEligibility.minimumQualifyingIntervalPlayCount &&
      interval.strength >= PUBLIC_SELECTION_POLICY.artistEligibility.minimumPeakStrength,
  );
}

/**
 * Applies the significance boundary before the public result limit. Ranking is based only on
 * qualifying aggregate interval evidence and the already reviewed public slug.
 */
export function selectEligiblePublicArtists(
  candidates: readonly PublicArtistSelectionCandidate[],
): readonly PublicArtistSelectionCandidate[] {
  const slugs = new Set<string>();
  for (const candidate of candidates) {
    validateArtistCandidate(candidate);
    if (slugs.has(candidate.slug)) {
      throw new PublicationPolicyError(`Artist public slug must be unique: ${candidate.slug}`);
    }
    slugs.add(candidate.slug);
  }

  return candidates
    .filter((candidate) => isPublicArtistEligible(candidate))
    .toSorted((left, right) => {
      const leftBest = bestQualifyingInterval(left);
      const rightBest = bestQualifyingInterval(right);
      if (leftBest.playCount !== rightBest.playCount) {
        return rightBest.playCount - leftBest.playCount;
      }
      if (leftBest.strength !== rightBest.strength) {
        return rightBest.strength - leftBest.strength;
      }
      return compareText(left.slug, right.slug);
    })
    .slice(0, PUBLIC_SELECTION_POLICY.artistEligibility.maximumArtists);
}

/**
 * Track display values cross the public boundary only when a manually authored selection key is
 * present in the allowlist. The private selection key is deliberately omitted from the result.
 */
export function selectEditorialTrackDetails(
  candidates: readonly SelectedTrackCandidate[],
  allowlist: readonly SelectedTrackAllowlistEntry[],
): readonly PublicSelectedTrackDetail[] {
  const candidatesByKey = uniqueBySelectionKey(candidates, "Track candidate");
  const selectionKeys = new Set<string>();
  const storySlugs = new Set<string>();
  const trackSlugs = new Set<string>();

  return allowlist.map((entry) => {
    validateRequiredText(entry.selectionKey, "Track selection key");
    assertPublicSlug(entry.storySlug, "Story slug");
    assertPublicSlug(entry.trackSlug, "Track slug");
    if (selectionKeys.has(entry.selectionKey)) {
      throw new PublicationPolicyError("Track selection keys must be unique");
    }
    if (storySlugs.has(entry.storySlug)) {
      throw new PublicationPolicyError(`A story may select at most one track: ${entry.storySlug}`);
    }
    if (trackSlugs.has(entry.trackSlug)) {
      throw new PublicationPolicyError(`Track public slug must be unique: ${entry.trackSlug}`);
    }
    selectionKeys.add(entry.selectionKey);
    storySlugs.add(entry.storySlug);
    trackSlugs.add(entry.trackSlug);

    const candidate = candidatesByKey.get(entry.selectionKey);
    if (candidate === undefined) {
      throw new PublicationPolicyError("Selected track key does not resolve to one candidate");
    }
    return {
      artistDisplayName: candidate.artistDisplayName,
      slug: entry.trackSlug,
      storySlug: entry.storySlug,
      trackDisplayName: candidate.trackDisplayName,
    };
  });
}

function validateArtistCandidate(candidate: PublicArtistSelectionCandidate): void {
  assertPublicSlug(candidate.slug, "Artist slug");
  validateRequiredText(candidate.displayName, "Artist display name");
  if (!Array.isArray(candidate.intervals)) {
    throw new PublicationPolicyError("Artist intervals must be an array");
  }
  for (const interval of candidate.intervals) {
    validateCount(interval.playCount, "Artist interval play count");
    validateRate(interval.strength, "Artist interval strength");
  }
}

function bestQualifyingInterval(candidate: PublicArtistSelectionCandidate): {
  readonly playCount: number;
  readonly strength: number;
} {
  const qualifying = candidate.intervals.filter(
    (interval) =>
      interval.playCount >=
        PUBLIC_SELECTION_POLICY.artistEligibility.minimumQualifyingIntervalPlayCount &&
      interval.strength >= PUBLIC_SELECTION_POLICY.artistEligibility.minimumPeakStrength,
  );
  const first = qualifying[0];
  if (first === undefined) {
    throw new PublicationPolicyError("Eligible artist must have a qualifying interval");
  }
  return qualifying.slice(1).reduce((best, interval) => {
    if (interval.playCount !== best.playCount) {
      return interval.playCount > best.playCount ? interval : best;
    }
    return interval.strength > best.strength ? interval : best;
  }, first);
}

function uniqueBySelectionKey(
  candidates: readonly SelectedTrackCandidate[],
  label: string,
): ReadonlyMap<string, SelectedTrackCandidate> {
  const result = new Map<string, SelectedTrackCandidate>();
  for (const candidate of candidates) {
    validateRequiredText(candidate.selectionKey, `${label} selection key`);
    validateRequiredText(candidate.artistDisplayName, `${label} artist display name`);
    validateRequiredText(candidate.trackDisplayName, `${label} track display name`);
    if (result.has(candidate.selectionKey)) {
      throw new PublicationPolicyError(
        `${label} selection key must resolve to exactly one candidate`,
      );
    }
    result.set(candidate.selectionKey, candidate);
  }
  return result;
}

function validateCanonicalUtcTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new PublicationPolicyError(`${label} must be a canonical UTC timestamp`);
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
    throw new PublicationPolicyError(`${label} must be a valid canonical UTC timestamp`);
  }
  return value;
}

function validatePresentationTimezone(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PublicationPolicyError("Presentation timezone must name a valid IANA timezone");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    throw new PublicationPolicyError("Presentation timezone must name a valid IANA timezone");
  }
  return value;
}

function validateCount(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PublicationPolicyError(`${label} must be a non-negative safe integer`);
  }
}

function validateRate(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new PublicationPolicyError(`${label} must be a number from 0 through 1`);
  }
}

function validateRequiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || /\p{Cc}/u.test(value)) {
    throw new PublicationPolicyError(
      `${label} must be non-empty and contain no control characters`,
    );
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
