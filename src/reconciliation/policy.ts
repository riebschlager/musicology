import { createHash } from "node:crypto";

import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import { CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION } from "./features.ts";

/**
 * P2-07's conservative, calibrated policy. The policy version intentionally names the feature
 * version it consumes: changing thresholds, hard rules, feature definitions, or rationale is a
 * new policy, rather than a silent reinterpretation of pending candidates.
 */
export const CROSS_SOURCE_DECISION_POLICY_VERSION = "cross-source-decision-policy-v1";
export const CALIBRATION_SAMPLE_VERSION = "cross-source-calibration-sample-v1";

export interface CrossSourceDecisionPolicy {
  readonly featureRuleVersion: string;
  readonly highConfidenceThreshold: number;
  readonly ignoreThreshold: number;
  readonly rationale: string;
  readonly version: string;
}

export const CROSS_SOURCE_DECISION_POLICY = {
  featureRuleVersion: CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION,
  highConfidenceThreshold: 0.95,
  ignoreThreshold: 0.7,
  rationale:
    "A false merge erases a listening-history distinction, so automatic acceptance requires very high aggregate confidence, no strong-identifier disagreement, and exactly one compatible candidate on each side. Candidates below the review threshold are retained as ignored rather than treated as evidence of non-matching identity.",
  version: CROSS_SOURCE_DECISION_POLICY_VERSION,
} as const satisfies CrossSourceDecisionPolicy;

export type ReconciliationDecision = "auto_accept" | "ignore" | "review";

export interface CandidatePolicyInput {
  readonly competingCandidateScore: number;
  readonly identifierAgreement: 0 | 1 | null;
  readonly totalConfidence: number;
}

/** Applies P2-07 hard rules before confidence bands. It never writes decisions; P2-08 owns that. */
export function classifyReconciliationCandidate(
  candidate: CandidatePolicyInput,
  policy: Pick<
    CrossSourceDecisionPolicy,
    "highConfidenceThreshold" | "ignoreThreshold"
  > = CROSS_SOURCE_DECISION_POLICY,
): ReconciliationDecision {
  validateScore(candidate.totalConfidence, "totalConfidence");
  validateScore(candidate.competingCandidateScore, "competingCandidateScore");

  // A comparable strong identifier that resolves to different tracks is never auto-merged.
  if (candidate.identifierAgreement === 0) return "review";

  // A score below 1 means a Spotify or Last.fm occurrence has another plausible generated pair.
  // P2-06 intentionally records candidate-set ambiguity separately from aggregate confidence.
  if (candidate.competingCandidateScore !== 1) return "review";

  if (candidate.totalConfidence >= policy.highConfidenceThreshold) {
    return "auto_accept";
  }
  if (candidate.totalConfidence >= policy.ignoreThreshold) return "review";
  return "ignore";
}

export interface CalibrationSampleCandidate {
  readonly candidateId: number;
  readonly competingCandidateScore: number;
  readonly identifierAgreement: 0 | 1 | null;
  readonly label: null;
  readonly proposedDecision: ReconciliationDecision;
  readonly spotifySourceRecordId: number;
  readonly lastfmSourceRecordId: number;
  readonly totalConfidence: number;
}

export interface CalibrationSample {
  readonly candidates: readonly CalibrationSampleCandidate[];
  readonly featureRuleVersion: typeof CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION;
  readonly policy: typeof CROSS_SOURCE_DECISION_POLICY;
  readonly sampleVersion: typeof CALIBRATION_SAMPLE_VERSION;
}

interface CandidateRow extends SqliteRow {
  readonly candidate_id: number;
  readonly competing_candidate_score: number;
  readonly identifier_agreement: 0 | 1 | null;
  readonly lastfm_source_record_id: number;
  readonly spotify_source_record_id: number;
  readonly stratum: CalibrationSampleStratum;
  readonly total_confidence: number;
}

type CalibrationSampleStratum =
  | "ambiguous"
  | "high_confidence"
  | "ignore"
  | "review"
  | "strong_identifier_conflict";

/**
 * Returns a deterministic, stratified calibration export without display text, timestamps,
 * source paths, hashes, account data, or raw records. Labels are deliberately null so a local
 * reviewer supplies them outside the canonical database before selecting a later policy version.
 */
export function exportCalibrationSample(
  connection: SqliteConnection,
  options: { readonly perStratum?: number } = {},
): CalibrationSample {
  const perStratum = options.perStratum ?? 25;
  if (!Number.isInteger(perStratum) || perStratum < 1 || perStratum > 1000) {
    throw new RangeError("perStratum must be an integer from 1 to 1000");
  }
  const rows = connection
    .prepare<CandidateRow>(CALIBRATION_SAMPLE_SQL)
    .all({ featureRuleVersion: CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION });
  const candidates = selectStratifiedCandidates(rows, perStratum).map(
    (row): CalibrationSampleCandidate => ({
      candidateId: row.candidate_id,
      competingCandidateScore: row.competing_candidate_score,
      identifierAgreement: row.identifier_agreement,
      label: null,
      proposedDecision: classifyReconciliationCandidate({
        competingCandidateScore: row.competing_candidate_score,
        identifierAgreement: row.identifier_agreement,
        totalConfidence: row.total_confidence,
      }),
      spotifySourceRecordId: row.spotify_source_record_id,
      lastfmSourceRecordId: row.lastfm_source_record_id,
      totalConfidence: row.total_confidence,
    }),
  );
  return {
    candidates,
    featureRuleVersion: CROSS_SOURCE_MATCH_FEATURE_RULE_VERSION,
    policy: CROSS_SOURCE_DECISION_POLICY,
    sampleVersion: CALIBRATION_SAMPLE_VERSION,
  };
}

/**
 * A stable hash permutes each stratum without inheriting source ingestion order. Keeping the
 * candidate ID as a tie-breaker makes the result exact and repeatable if a hash collision occurs.
 */
function selectStratifiedCandidates(
  rows: readonly CandidateRow[],
  perStratum: number,
): readonly CandidateRow[] {
  const byStratum = new Map<CalibrationSampleStratum, CandidateRow[]>();
  for (const row of rows) {
    const stratum = byStratum.get(row.stratum) ?? [];
    stratum.push(row);
    byStratum.set(row.stratum, stratum);
  }

  return [...byStratum.entries()]
    .flatMap(([, stratumRows]) =>
      stratumRows
        .sort(
          (left, right) =>
            deterministicSamplingRank(left.candidate_id).localeCompare(
              deterministicSamplingRank(right.candidate_id),
            ) || left.candidate_id - right.candidate_id,
        )
        .slice(0, perStratum),
    )
    .sort(
      (left, right) =>
        left.stratum.localeCompare(right.stratum) || left.candidate_id - right.candidate_id,
    );
}

function deterministicSamplingRank(candidateId: number): string {
  return createHash("sha256")
    .update(`${CALIBRATION_SAMPLE_VERSION}:${String(candidateId)}`)
    .digest("hex");
}

function validateScore(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite score from 0 to 1`);
  }
}

const CALIBRATION_SAMPLE_SQL = `
  WITH classified AS (
    SELECT id AS candidate_id,
           spotify_source_record_id,
           lastfm_source_record_id,
           identifier_agreement,
           competing_candidate_score,
           total_confidence,
           CASE
             WHEN identifier_agreement = 0 THEN 'strong_identifier_conflict'
             WHEN competing_candidate_score <> 1 THEN 'ambiguous'
             WHEN total_confidence >= ${String(CROSS_SOURCE_DECISION_POLICY.highConfidenceThreshold)} THEN 'high_confidence'
             WHEN total_confidence >= ${String(CROSS_SOURCE_DECISION_POLICY.ignoreThreshold)} THEN 'review'
             ELSE 'ignore'
           END AS stratum
      FROM reconciliation_candidate
     WHERE rule_version = @featureRuleVersion
       AND candidate_state = 'pending'
  )
  SELECT candidate_id, spotify_source_record_id, lastfm_source_record_id, identifier_agreement,
         competing_candidate_score, total_confidence, stratum
    FROM classified
   ORDER BY stratum, candidate_id
`;
