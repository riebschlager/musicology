import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import {
  classifyReconciliationCandidate,
  CROSS_SOURCE_DECISION_POLICY,
  type CrossSourceDecisionPolicy,
  type ReconciliationDecision,
} from "./policy.ts";

export interface ApplyReconciliationOptions {
  readonly dryRun?: boolean;
  readonly now?: () => number;
  readonly policy?: CrossSourceDecisionPolicy;
}

export interface ReconciliationApplySummary {
  readonly autoAccepted: number;
  readonly ignored: number;
  readonly review: number;
  readonly skipped: number;
  readonly supersededAutomaticDecisions: number;
  readonly dryRun: boolean;
  readonly policyRuleVersion: string;
}

interface MutableReconciliationApplySummary {
  autoAccepted: number;
  ignored: number;
  review: number;
  skipped: number;
  supersededAutomaticDecisions: number;
  dryRun: boolean;
  policyRuleVersion: string;
}

interface CandidateRow extends SqliteRow {
  readonly candidate_id: number;
  readonly spotify_source_record_id: number;
  readonly lastfm_source_record_id: number;
  readonly identifier_agreement: 0 | 1 | null;
  readonly competing_candidate_score: number;
  readonly total_confidence: number;
  readonly prior_decision_id: number | null;
  readonly prior_decision: "auto_accept" | "review" | "ignore" | null;
}

interface EventLinkRow extends SqliteRow {
  readonly lastfm_occurrence_source_record_id: number;
  readonly source_event_id: number;
  readonly source_event_status: "current" | "unresolved";
  readonly target_event_id: number;
}

/**
 * Applies one named reconciliation policy against its feature version. Candidate feature rows are
 * immutable evidence: the application history records policy outcomes separately, and only a
 * qualifying automatic acceptance changes canonical provenance.
 */
export function applyReconciliationDecisions(
  connection: SqliteConnection,
  options: ApplyReconciliationOptions = {},
): ReconciliationApplySummary {
  const policy = options.policy ?? CROSS_SOURCE_DECISION_POLICY;
  validatePolicy(policy);
  const dryRun = options.dryRun ?? false;
  const now = (options.now ?? (() => Date.now()))();

  return connection.transaction(() => {
    const candidates = connection.prepare<CandidateRow>(CANDIDATES_SQL).all({
      featureRuleVersion: policy.featureRuleVersion,
      policyRuleVersion: policy.version,
    });
    const summary = emptySummary(policy.version, dryRun);

    for (const candidate of candidates) {
      const decision = classifyReconciliationCandidate(
        {
          competingCandidateScore: candidate.competing_candidate_score,
          identifierAgreement: candidate.identifier_agreement,
          totalConfidence: candidate.total_confidence,
        },
        policy,
      );
      if (decision === "auto_accept") {
        const priorDecisionId = dryRun
          ? null
          : supersedePriorDecision(connection, candidate, summary);
        const links = findMergeLinks(connection, candidate);
        if (links === undefined) {
          // An already-linked or otherwise stale candidate must never move evidence by guesswork.
          summary.review += 1;
          if (!dryRun) {
            const decisionId = recordDecision(connection, candidate, "review", policy, now);
            finalizeSupersession(connection, priorDecisionId, decisionId);
          }
          continue;
        }
        summary.autoAccepted += 1;
        if (!dryRun) {
          const decisionId = mergeEvents(connection, candidate, links, policy, now);
          finalizeSupersession(connection, priorDecisionId, decisionId);
        }
        continue;
      }

      if (decision === "review") summary.review += 1;
      else summary.ignored += 1;
      if (!dryRun) {
        const priorDecisionId = supersedePriorDecision(connection, candidate, summary);
        const decisionId = recordDecision(connection, candidate, decision, policy, now);
        finalizeSupersession(connection, priorDecisionId, decisionId);
      }
    }
    return summary;
  });
}

function emptySummary(
  policyRuleVersion: string,
  dryRun: boolean,
): MutableReconciliationApplySummary {
  return {
    autoAccepted: 0,
    ignored: 0,
    review: 0,
    skipped: 0,
    supersededAutomaticDecisions: 0,
    dryRun,
    policyRuleVersion,
  };
}

function validatePolicy(policy: CrossSourceDecisionPolicy): void {
  if (
    policy.version.length === 0 ||
    policy.featureRuleVersion.length === 0 ||
    policy.rationale.length === 0 ||
    !Number.isFinite(policy.highConfidenceThreshold) ||
    !Number.isFinite(policy.ignoreThreshold) ||
    policy.ignoreThreshold < 0 ||
    policy.highConfidenceThreshold > 1 ||
    policy.ignoreThreshold > policy.highConfidenceThreshold
  ) {
    throw new RangeError("Reconciliation policy is invalid");
  }
}

function findMergeLinks(
  connection: SqliteConnection,
  candidate: CandidateRow,
): EventLinkRow | undefined {
  return connection
    .prepare<EventLinkRow>(MERGE_LINKS_SQL)
    .get([candidate.lastfm_source_record_id, candidate.spotify_source_record_id]);
}

function supersedePriorDecision(
  connection: SqliteConnection,
  candidate: CandidateRow,
  summary: MutableReconciliationApplySummary,
): number | null {
  if (candidate.prior_decision_id === null) return null;
  if (candidate.prior_decision === "auto_accept") {
    connection
      .prepare(
        `UPDATE listening_event_source
            SET listening_event_id = decision.source_listening_event_id,
                evidence_role = 'primary', accepted_match_score = NULL,
                reconciliation_candidate_id = NULL
           FROM reconciliation_decision AS decision
          WHERE decision.id = ?
            AND listening_event_source.listening_event_id = decision.target_listening_event_id
            AND listening_event_source.evidence_role = 'cross_source_match'
            AND listening_event_source.reconciliation_candidate_id = decision.reconciliation_candidate_id`,
      )
      .run([candidate.prior_decision_id]);
    connection
      .prepare(
        `UPDATE listening_event
            SET event_status = decision.source_event_status, superseded_by_event_id = NULL
           FROM reconciliation_decision AS decision
          WHERE decision.id = ? AND listening_event.id = decision.source_listening_event_id`,
      )
      .run([candidate.prior_decision_id]);
    summary.supersededAutomaticDecisions += 1;
  }
  return candidate.prior_decision_id;
}

function finalizeSupersession(
  connection: SqliteConnection,
  priorDecisionId: number | null,
  replacementDecisionId: number,
): void {
  if (priorDecisionId === null) return;
  connection
    .prepare(
      `UPDATE reconciliation_decision
          SET decision_state = 'superseded', superseded_by_decision_id = ?
        WHERE id = ? AND decision_state = 'active'`,
    )
    .run([replacementDecisionId, priorDecisionId]);
}

function mergeEvents(
  connection: SqliteConnection,
  candidate: CandidateRow,
  links: EventLinkRow,
  policy: CrossSourceDecisionPolicy,
  now: number,
): number {
  const decisionId = insertDecision(connection, candidate, "auto_accept", policy, now, links);
  connection
    .prepare(
      `UPDATE listening_event_source
          SET listening_event_id = ?, evidence_role = 'cross_source_match', accepted_match_score = ?,
              reconciliation_candidate_id = ?
        WHERE listening_event_id = ? AND source_record_id = ? AND evidence_role = 'primary'`,
    )
    .run([
      links.target_event_id,
      candidate.total_confidence,
      candidate.candidate_id,
      links.source_event_id,
      links.lastfm_occurrence_source_record_id,
    ]);
  connection
    .prepare(
      `UPDATE listening_event
          SET event_status = 'superseded', superseded_by_event_id = ?, reconciliation_rule_version = ?
        WHERE id = ?`,
    )
    .run([links.target_event_id, policy.version, links.source_event_id]);
  connection
    .prepare(
      `UPDATE listening_event
          SET reconciliation_rule_version = ?
        WHERE id = ?`,
    )
    .run([policy.version, links.target_event_id]);
  connection
    .prepare(
      `UPDATE reconciliation_candidate
          SET candidate_state = 'auto_accepted', resolved_at_epoch_ms = ?, resolution_rationale = ?
        WHERE id = ?`,
    )
    .run([now, `Automatically accepted by ${policy.version}.`, candidate.candidate_id]);
  return decisionId;
}

function insertDecision(
  connection: SqliteConnection,
  candidate: CandidateRow,
  decision: ReconciliationDecision,
  policy: CrossSourceDecisionPolicy,
  now: number,
  links?: EventLinkRow,
): number {
  return Number(
    connection
      .prepare(
        `INSERT INTO reconciliation_decision
          (reconciliation_candidate_id, policy_rule_version, decision, applied_at_epoch_ms,
           decision_state, source_listening_event_id, target_listening_event_id, source_event_status,
           rationale)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run([
        candidate.candidate_id,
        policy.version,
        decision,
        now,
        links?.source_event_id ?? null,
        links?.target_event_id ?? null,
        links?.source_event_status ?? null,
        policy.rationale,
      ]).lastInsertRowid,
  );
}

function recordDecision(
  connection: SqliteConnection,
  candidate: CandidateRow,
  decision: "auto_accept",
  policy: CrossSourceDecisionPolicy,
  now: number,
): number;
function recordDecision(
  connection: SqliteConnection,
  candidate: CandidateRow,
  decision: Exclude<ReconciliationDecision, "auto_accept">,
  policy: CrossSourceDecisionPolicy,
  now: number,
): number;
function recordDecision(
  connection: SqliteConnection,
  candidate: CandidateRow,
  decision: ReconciliationDecision,
  policy: CrossSourceDecisionPolicy,
  now: number,
): number {
  if (decision === "auto_accept") throw new Error("Automatic acceptance requires event links");
  const decisionId = insertDecision(connection, candidate, decision, policy, now);
  if (decision === "ignore") {
    connection
      .prepare(
        `UPDATE reconciliation_candidate SET candidate_state = 'auto_rejected', resolved_at_epoch_ms = ?, resolution_rationale = ? WHERE id = ?`,
      )
      .run([now, `Ignored by ${policy.version}.`, candidate.candidate_id]);
  } else {
    connection
      .prepare(
        `UPDATE reconciliation_candidate
            SET candidate_state = 'pending', resolved_at_epoch_ms = NULL, resolution_rationale = NULL
          WHERE id = ?`,
      )
      .run([candidate.candidate_id]);
  }
  return decisionId;
}

const CANDIDATES_SQL = `
  SELECT candidate.id AS candidate_id, candidate.spotify_source_record_id,
         candidate.lastfm_source_record_id, candidate.identifier_agreement,
         candidate.competing_candidate_score, candidate.total_confidence,
         prior.id AS prior_decision_id, prior.decision AS prior_decision
    FROM reconciliation_candidate AS candidate
    LEFT JOIN reconciliation_decision AS current
      ON current.reconciliation_candidate_id = candidate.id
     AND current.policy_rule_version = @policyRuleVersion
     AND current.decision_state = 'active'
    LEFT JOIN reconciliation_decision AS prior
      ON prior.reconciliation_candidate_id = candidate.id
     AND prior.decision_state = 'active'
   WHERE candidate.rule_version = @featureRuleVersion
     AND current.id IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM manual_reconciliation_decision AS manual
        WHERE manual.reconciliation_candidate_id = candidate.id
     )
   ORDER BY candidate.id
`;

const MERGE_LINKS_SQL = `
  SELECT occurrence.source_record_id AS lastfm_occurrence_source_record_id,
         lastfm_event.id AS source_event_id, lastfm_event.event_status AS source_event_status,
         spotify_event.id AS target_event_id
    FROM listening_event_source AS spotify_link
    JOIN listening_event AS spotify_event ON spotify_event.id = spotify_link.listening_event_id
    JOIN lastfm_scrobble_occurrence AS occurrence
      ON occurrence.lastfm_scrobble_source_record_id = ?
    JOIN listening_event_source AS lastfm_link ON lastfm_link.source_record_id = occurrence.source_record_id
    JOIN listening_event AS lastfm_event ON lastfm_event.id = lastfm_link.listening_event_id
   WHERE spotify_link.source_record_id = ?
     AND spotify_link.evidence_role = 'primary'
     AND spotify_event.event_status IN ('current', 'unresolved')
     AND lastfm_link.evidence_role = 'primary'
     AND lastfm_event.event_status IN ('current', 'unresolved')
   ORDER BY occurrence.source_record_id
   LIMIT 1
`;
