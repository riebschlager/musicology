/**
 * Matching-only text normalization. Display text stays source-derived and must never be replaced
 * with this value. A semantic change to this algorithm requires a new rule version.
 */
export const MATCH_TEXT_NORMALIZATION_VERSION = "match-text-v1";

export interface NormalizedMatchText {
  readonly displayText: string;
  readonly normalizedText: string | null;
  readonly normalizationVersion: typeof MATCH_TEXT_NORMALIZATION_VERSION;
}

const FEATURING_MARKER = /\b(?:feat(?:\.|uring)?|ft\.?)\b/giu;
const PUNCTUATION = /[\p{P}\p{S}]/gu;
const WHITESPACE = /\s+/gu;

/**
 * Produces a deterministic matching key without changing the source display value. It deliberately
 * retains words such as "live", "remix", "radio edit", "version", and movement names.
 */
export function normalizeMatchText(displayText: string): string | null {
  const normalized = displayText
    .normalize("NFC")
    .toLowerCase()
    .replace(FEATURING_MARKER, " feat ")
    .replace(PUNCTUATION, "")
    .replace(WHITESPACE, " ")
    .trim();

  return normalized.length === 0 ? null : normalized;
}

/** Creates the versioned pair that later identity persistence will store in separate fields. */
export function normalizeDisplayText(displayText: string): NormalizedMatchText {
  return {
    displayText,
    normalizedText: normalizeMatchText(displayText),
    normalizationVersion: MATCH_TEXT_NORMALIZATION_VERSION,
  };
}
