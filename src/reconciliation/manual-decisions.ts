import { normalizeMatchText, MATCH_TEXT_NORMALIZATION_VERSION } from "../identity/normalization.ts";
import type { SqliteConnection, SqliteRow } from "../db/connection.ts";

export const MANUAL_DECISION_ARTIFACT_VERSION = "manual-decisions-v1";
export const MANUAL_REVIEW_EXPORT_VERSION = "manual-review-export-v1";

export type SourceReference = Readonly<{
  sourceFileContentSha256: string;
  sourceKind: "spotify" | "lastfm";
  sourceOrdinal: number;
}>;

type EntityReference = Readonly<{
  entityType: "artist" | "release" | "track";
  source: SourceReference;
}>;
export type ManualDecision =
  | Readonly<{
      id: string;
      type: "accept" | "reject";
      candidate: { spotify: SourceReference; lastfm: SourceReference };
      reasonCode: string;
    }>
  | Readonly<{
      id: string;
      type: "merge" | "split";
      subject: EntityReference;
      object: EntityReference;
      reasonCode: string;
    }>
  | Readonly<{
      id: string;
      type: "alias";
      subject: EntityReference;
      alias: string;
      reasonCode: string;
    }>;
type IdentityManualDecision = Exclude<ManualDecision, { type: "accept" | "reject" }>;

export interface ManualDecisionArtifact {
  readonly artifactVersion: typeof MANUAL_DECISION_ARTIFACT_VERSION;
  readonly decisions: readonly ManualDecision[];
}
export interface ManualImportSummary {
  readonly imported: number;
  readonly alreadyApplied: number;
  readonly backupRequired: boolean;
}

interface IdRow extends SqliteRow {
  readonly id: number;
}
interface CandidateRow extends SqliteRow {
  readonly candidate_id: number;
  readonly source_event_id: number;
  readonly target_event_id: number;
  readonly source_event_status: "current" | "unresolved";
}
interface PriorMergeRow extends SqliteRow {
  readonly decision_key: string;
  readonly identity_decision_id: number;
  readonly subject_entity_id: number;
  readonly object_entity_id: number;
}

export function parseManualDecisionArtifact(value: unknown): ManualDecisionArtifact {
  if (
    !isObject(value) ||
    value.artifactVersion !== MANUAL_DECISION_ARTIFACT_VERSION ||
    !Array.isArray(value.decisions)
  )
    throw new TypeError("Manual decision artifact format is invalid");
  const decisions = value.decisions.map(parseDecision);
  if (new Set(decisions.map((decision) => decision.id)).size !== decisions.length)
    throw new TypeError("Manual decision artifact contains duplicate decision IDs");
  return { artifactVersion: MANUAL_DECISION_ARTIFACT_VERSION, decisions };
}

export function importManualDecisions(
  connection: SqliteConnection,
  artifact: ManualDecisionArtifact,
  now = Date.now(),
): ManualImportSummary {
  let imported = 0;
  let alreadyApplied = 0;
  connection.transaction(() => {
    for (const decision of artifact.decisions) {
      const payload = canonicalPayload(decision);
      const prior = connection
        .prepare<{ readonly payload_json: string }>(
          "SELECT payload_json FROM manual_decision_artifact WHERE decision_key = ?",
        )
        .get([decision.id]);
      if (prior !== undefined) {
        if (prior.payload_json !== payload)
          throw new TypeError("A manual decision ID is already bound to different content");
        alreadyApplied++;
        continue;
      }
      if (isReconciliationDecision(decision)) {
        applyReconciliationDecision(connection, decision, payload, now);
      } else {
        applyIdentityDecision(connection, decision, payload, now);
      }
      imported++;
    }
  });
  return { imported, alreadyApplied, backupRequired: artifact.decisions.length > 0 };
}

export function exportManualReview(
  connection: SqliteConnection,
): Readonly<Record<string, unknown>> {
  const candidates = connection
    .prepare<CandidateExportRow>(CANDIDATE_EXPORT_SQL)
    .all()
    .map((row) => ({
      candidate: {
        spotify: sourceReference(row.spotify_kind, row.spotify_hash, row.spotify_ordinal),
        lastfm: sourceReference(row.lastfm_kind, row.lastfm_hash, row.lastfm_ordinal),
      },
      candidateState: row.candidate_state,
      identifierAgreement: row.identifier_agreement,
      totalConfidence: row.total_confidence,
    }));
  const decisions = connection
    .prepare<{ readonly payload_json: string }>(
      "SELECT payload_json FROM manual_decision_artifact ORDER BY decision_key",
    )
    .all()
    .map((row) => JSON.parse(row.payload_json));
  return {
    artifactVersion: MANUAL_DECISION_ARTIFACT_VERSION,
    candidates,
    decisions,
    exportVersion: MANUAL_REVIEW_EXPORT_VERSION,
  };
}

interface CandidateExportRow extends SqliteRow {
  readonly spotify_kind: "spotify";
  readonly spotify_hash: string;
  readonly spotify_ordinal: number;
  readonly lastfm_kind: "lastfm";
  readonly lastfm_hash: string;
  readonly lastfm_ordinal: number;
  readonly candidate_state: string;
  readonly identifier_agreement: number | null;
  readonly total_confidence: number;
}

function applyReconciliationDecision(
  connection: SqliteConnection,
  decision: Extract<ManualDecision, { type: "accept" | "reject" }>,
  payload: string,
  now: number,
): void {
  const candidate = findCandidate(connection, decision.candidate);
  if (candidate === undefined)
    throw new TypeError("Manual reconciliation decision references a stale candidate");
  let links: CandidateRow | undefined;
  if (decision.type === "accept") {
    links = findMergeLinks(connection, candidate.candidate_id);
    if (links === undefined)
      throw new TypeError("Manual acceptance references events that cannot safely be merged");
    connection
      .prepare(
        "UPDATE listening_event_source SET listening_event_id = ?, evidence_role = 'cross_source_match', accepted_match_score = NULL, reconciliation_candidate_id = ? WHERE listening_event_id = ? AND source_record_id = (SELECT lastfm_source_record_id FROM reconciliation_candidate WHERE id = ?)",
      )
      .run([
        links.target_event_id,
        candidate.candidate_id,
        links.source_event_id,
        candidate.candidate_id,
      ]);
    connection
      .prepare(
        "UPDATE listening_event SET event_status = 'superseded', superseded_by_event_id = ? WHERE id = ?",
      )
      .run([links.target_event_id, links.source_event_id]);
    connection
      .prepare(
        "UPDATE reconciliation_candidate SET candidate_state = 'manually_accepted', resolved_at_epoch_ms = ?, resolution_rationale = 'Manual decision artifact.' WHERE id = ?",
      )
      .run([now, candidate.candidate_id]);
  } else {
    restoreCandidateMerge(connection, candidate.candidate_id);
    connection
      .prepare(
        "UPDATE reconciliation_candidate SET candidate_state = 'manually_rejected', resolved_at_epoch_ms = ?, resolution_rationale = 'Manual decision artifact.' WHERE id = ?",
      )
      .run([now, candidate.candidate_id]);
  }
  connection
    .prepare(
      "INSERT INTO manual_decision_artifact (decision_key, artifact_version, decision_type, payload_json, imported_at_epoch_ms) VALUES (?, ?, ?, ?, ?)",
    )
    .run([decision.id, MANUAL_DECISION_ARTIFACT_VERSION, decision.type, payload, now]);
  connection
    .prepare(
      "INSERT INTO manual_reconciliation_decision (decision_key, reconciliation_candidate_id, decision, source_listening_event_id, target_listening_event_id, source_event_status) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run([
      decision.id,
      candidate.candidate_id,
      decision.type,
      links?.source_event_id ?? null,
      links?.target_event_id ?? null,
      links?.source_event_status ?? null,
    ]);
}

function applyIdentityDecision(
  connection: SqliteConnection,
  decision: IdentityManualDecision,
  payload: string,
  now: number,
): void {
  const subject = findEntity(connection, decision.subject);
  if (subject === undefined)
    throw new TypeError("Manual identity decision references a stale subject");
  const subjectSourceRecordId = sourceRecordId(connection, decision.subject.source);
  let object: number | null = null;
  let objectSourceRecordId: number | null = null;
  let supersedesDecisionId: number | null = null;
  if (decision.type === "merge" || decision.type === "split") {
    objectSourceRecordId = sourceRecordId(connection, decision.object.source);
    if (decision.subject.entityType !== decision.object.entityType)
      throw new TypeError("Manual identity decision references incompatible entities");
    if (decision.type === "merge") {
      const resolvedObject = findEntity(connection, decision.object);
      if (resolvedObject === undefined || resolvedObject === subject)
        throw new TypeError("Manual identity decision references incompatible entities");
      object = resolvedObject;
    } else {
      const priorMerge = findActiveMerge(
        connection,
        subjectSourceRecordId,
        objectSourceRecordId,
        decision.subject.entityType,
      );
      if (
        priorMerge === undefined ||
        subject !== priorMerge.subject_entity_id ||
        findEntity(connection, decision.object) !== priorMerge.subject_entity_id
      )
        throw new TypeError("Manual split does not reference an active manual merge");
      object = priorMerge.object_entity_id;
      supersedesDecisionId = priorMerge.identity_decision_id;
    }
  }
  const identityDecisionId = Number(
    connection
      .prepare(
        "INSERT INTO identity_decision (decision_type, subject_entity_id, object_entity_id, alias_text, decided_at_epoch_ms, decision_version, rationale, supersedes_decision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run([
        decision.type,
        subject,
        object,
        decision.type === "alias" ? decision.alias : null,
        now,
        MANUAL_DECISION_ARTIFACT_VERSION,
        `Manual ${decision.type}: ${decision.reasonCode}.`,
        supersedesDecisionId,
      ]).lastInsertRowid,
  );
  if (decision.type === "alias" && decision.subject.entityType === "artist") {
    const normalized = normalizeMatchText(decision.alias);
    if (normalized === null) throw new TypeError("Manual alias is invalid");
    connection
      .prepare(
        "INSERT OR IGNORE INTO artist_alias (artist_id, display_alias, normalized_alias, normalization_version, alias_source, identity_decision_id) VALUES (?, ?, ?, ?, 'manual', ?)",
      )
      .run([
        subject,
        decision.alias,
        normalized,
        MATCH_TEXT_NORMALIZATION_VERSION,
        identityDecisionId,
      ]);
  }
  connection
    .prepare(
      "INSERT INTO manual_decision_artifact (decision_key, artifact_version, decision_type, payload_json, imported_at_epoch_ms) VALUES (?, ?, ?, ?, ?)",
    )
    .run([decision.id, MANUAL_DECISION_ARTIFACT_VERSION, decision.type, payload, now]);
  connection
    .prepare(
      "INSERT INTO manual_identity_decision (decision_key, identity_decision_id, subject_source_record_id, object_source_record_id) VALUES (?, ?, ?, ?)",
    )
    .run([decision.id, identityDecisionId, subjectSourceRecordId, objectSourceRecordId]);
  if (decision.type === "merge" && object !== null)
    applyManualMerge(connection, decision.id, decision.subject.entityType, subject, object);
  if (decision.type === "split" && supersedesDecisionId !== null && objectSourceRecordId !== null)
    restoreManualMerge(
      connection,
      subjectSourceRecordId,
      objectSourceRecordId,
      decision.subject.entityType,
      subject,
      supersedesDecisionId,
    );
}

function applyManualMerge(
  connection: SqliteConnection,
  decisionKey: string,
  entityType: EntityReference["entityType"],
  subject: number,
  object: number,
): void {
  const column = entityColumn(entityType);
  connection
    .prepare(
      `INSERT INTO manual_identity_resolution_override (manual_decision_key, source_record_id, artist_id, release_id, track_id, resolution_kind, resolution_rule_version, normalization_version, resolved_at_epoch_ms) SELECT ?, source_record_id, artist_id, release_id, track_id, resolution_kind, resolution_rule_version, normalization_version, resolved_at_epoch_ms FROM source_identity_resolution WHERE ${column} = ?`,
    )
    .run([decisionKey, object]);
  if (entityType === "artist") {
    connection
      .prepare(
        "INSERT INTO manual_identity_track_override (manual_decision_key, track_id, artist_id, release_id) SELECT ?, id, artist_id, NULL FROM track WHERE artist_id = ?",
      )
      .run([decisionKey, object]);
    connection.prepare("UPDATE track SET artist_id = ? WHERE artist_id = ?").run([subject, object]);
    connection
      .prepare(
        "UPDATE source_identity_resolution SET artist_id = ?, resolution_kind = 'manual_decision' WHERE artist_id = ?",
      )
      .run([subject, object]);
    return;
  }
  if (entityType === "release") {
    connection
      .prepare(
        "INSERT INTO manual_identity_track_override (manual_decision_key, track_id, artist_id, release_id) SELECT ?, id, NULL, release_id FROM track WHERE release_id = ?",
      )
      .run([decisionKey, object]);
    connection
      .prepare("UPDATE track SET release_id = ? WHERE release_id = ?")
      .run([subject, object]);
    connection
      .prepare(
        "UPDATE source_identity_resolution SET release_id = ?, resolution_kind = 'manual_decision' WHERE release_id = ?",
      )
      .run([subject, object]);
    return;
  }
  connection
    .prepare(
      "UPDATE source_identity_resolution SET artist_id = (SELECT artist_id FROM track WHERE id = ?), release_id = (SELECT release_id FROM track WHERE id = ?), track_id = ?, resolution_kind = 'manual_decision' WHERE track_id = ?",
    )
    .run([subject, subject, subject, object]);
  connection
    .prepare(
      "UPDATE listening_event SET track_id = ? WHERE id IN (SELECT DISTINCT link.listening_event_id FROM listening_event_source AS link JOIN manual_identity_resolution_override AS override ON override.source_record_id = link.source_record_id WHERE override.manual_decision_key = ?)",
    )
    .run([subject, decisionKey]);
}

function restoreManualMerge(
  connection: SqliteConnection,
  subjectSourceRecordId: number,
  objectSourceRecordId: number,
  entityType: EntityReference["entityType"],
  subject: number,
  mergeDecisionId: number,
): void {
  const merge = findMergeById(
    connection,
    subjectSourceRecordId,
    objectSourceRecordId,
    entityType,
    mergeDecisionId,
  );
  if (merge === undefined || merge.identity_decision_id !== mergeDecisionId)
    throw new TypeError("Manual split does not reference an active manual merge");
  if (entityType === "track") ensureTrackSplitIsSafe(connection, merge.decision_key, subject);
  connection
    .prepare(
      "UPDATE source_identity_resolution AS resolution SET artist_id = override.artist_id, release_id = override.release_id, track_id = override.track_id, resolution_kind = override.resolution_kind, resolution_rule_version = override.resolution_rule_version, normalization_version = override.normalization_version, resolved_at_epoch_ms = override.resolved_at_epoch_ms FROM manual_identity_resolution_override AS override WHERE override.manual_decision_key = ? AND override.source_record_id = resolution.source_record_id",
    )
    .run([merge.decision_key]);
  connection
    .prepare(
      "UPDATE track AS track SET artist_id = COALESCE(override.artist_id, track.artist_id), release_id = COALESCE(override.release_id, track.release_id) FROM manual_identity_track_override AS override WHERE override.manual_decision_key = ? AND override.track_id = track.id",
    )
    .run([merge.decision_key]);
  if (entityType === "track")
    connection
      .prepare(
        "UPDATE listening_event SET track_id = (SELECT override.track_id FROM listening_event_source AS link JOIN manual_identity_resolution_override AS override ON override.source_record_id = link.source_record_id WHERE override.manual_decision_key = ? AND link.listening_event_id = listening_event.id LIMIT 1) WHERE id IN (SELECT DISTINCT link.listening_event_id FROM listening_event_source AS link JOIN manual_identity_resolution_override AS override ON override.source_record_id = link.source_record_id WHERE override.manual_decision_key = ?)",
      )
      .run([merge.decision_key, merge.decision_key]);
}

function ensureTrackSplitIsSafe(
  connection: SqliteConnection,
  mergeDecisionKey: string,
  subject: number,
): void {
  const collision = connection
    .prepare<IdRow>(
      "SELECT event.id FROM listening_event AS event WHERE EXISTS (SELECT 1 FROM listening_event_source AS link JOIN manual_identity_resolution_override AS override ON override.source_record_id = link.source_record_id WHERE link.listening_event_id = event.id AND override.manual_decision_key = ?) AND EXISTS (SELECT 1 FROM listening_event_source AS link JOIN source_identity_resolution AS resolution ON resolution.source_record_id = link.source_record_id WHERE link.listening_event_id = event.id AND resolution.track_id = ? AND NOT EXISTS (SELECT 1 FROM manual_identity_resolution_override AS override WHERE override.manual_decision_key = ? AND override.source_record_id = link.source_record_id)) LIMIT 1",
    )
    .get([mergeDecisionKey, subject, mergeDecisionKey]);
  if (collision !== undefined)
    throw new TypeError("Manual track split would change a shared canonical event");
}
function entityColumn(
  entityType: EntityReference["entityType"],
): "artist_id" | "release_id" | "track_id" {
  return `${entityType}_id`;
}
function findActiveMerge(
  connection: SqliteConnection,
  subjectSourceRecordId: number,
  objectSourceRecordId: number,
  entityType: EntityReference["entityType"],
): PriorMergeRow | undefined {
  return connection
    .prepare<PriorMergeRow>(
      "SELECT manual.decision_key, decision.id AS identity_decision_id, decision.subject_entity_id, decision.object_entity_id FROM manual_identity_decision AS manual JOIN identity_decision AS decision ON decision.id = manual.identity_decision_id JOIN music_entity AS subject ON subject.id = decision.subject_entity_id WHERE manual.subject_source_record_id = ? AND manual.object_source_record_id = ? AND decision.decision_type = 'merge' AND subject.entity_type = ? AND NOT EXISTS (SELECT 1 FROM identity_decision AS superseding WHERE superseding.supersedes_decision_id = decision.id) ORDER BY decision.id DESC LIMIT 1",
    )
    .get([subjectSourceRecordId, objectSourceRecordId, entityType]);
}
function findMergeById(
  connection: SqliteConnection,
  subjectSourceRecordId: number,
  objectSourceRecordId: number,
  entityType: EntityReference["entityType"],
  mergeDecisionId: number,
): PriorMergeRow | undefined {
  return connection
    .prepare<PriorMergeRow>(
      "SELECT manual.decision_key, decision.id AS identity_decision_id, decision.subject_entity_id, decision.object_entity_id FROM manual_identity_decision AS manual JOIN identity_decision AS decision ON decision.id = manual.identity_decision_id JOIN music_entity AS subject ON subject.id = decision.subject_entity_id WHERE manual.subject_source_record_id = ? AND manual.object_source_record_id = ? AND decision.id = ? AND decision.decision_type = 'merge' AND subject.entity_type = ?",
    )
    .get([subjectSourceRecordId, objectSourceRecordId, mergeDecisionId, entityType]);
}

function findCandidate(
  connection: SqliteConnection,
  candidate: { spotify: SourceReference; lastfm: SourceReference },
): { candidate_id: number } | undefined {
  return connection
    .prepare<{ readonly candidate_id: number }>(`${CANDIDATE_BY_REFERENCE_SQL}`)
    .get([
      ...sourceReferenceParameters(candidate.spotify),
      ...sourceReferenceParameters(candidate.lastfm),
    ]);
}
function findEntity(connection: SqliteConnection, reference: EntityReference): number | undefined {
  return connection
    .prepare<IdRow>(
      `SELECT resolution.${reference.entityType}_id AS id FROM source_identity_resolution AS resolution WHERE resolution.source_record_id = ?`,
    )
    .get([sourceRecordId(connection, reference.source)])?.id;
}
function sourceRecordId(connection: SqliteConnection, ref: SourceReference): number {
  const row = connection.prepare<IdRow>(SOURCE_REFERENCE_SQL).get(sourceReferenceParameters(ref));
  if (row === undefined) throw new TypeError("Manual decision references stale source evidence");
  return row.id;
}
function findMergeLinks(
  connection: SqliteConnection,
  candidateId: number,
): CandidateRow | undefined {
  const current = connection
    .prepare<CandidateRow>(
      `SELECT candidate.id AS candidate_id, lastfm_event.id AS source_event_id, spotify_event.id AS target_event_id, lastfm_event.event_status AS source_event_status FROM reconciliation_candidate AS candidate JOIN listening_event_source AS spotify_link ON spotify_link.source_record_id = candidate.spotify_source_record_id JOIN listening_event AS spotify_event ON spotify_event.id = spotify_link.listening_event_id JOIN listening_event_source AS lastfm_link ON lastfm_link.source_record_id = candidate.lastfm_source_record_id JOIN listening_event AS lastfm_event ON lastfm_event.id = lastfm_link.listening_event_id WHERE candidate.id = ? AND spotify_link.evidence_role = 'primary' AND lastfm_link.evidence_role = 'primary' AND spotify_event.event_status IN ('current', 'unresolved') AND lastfm_event.event_status IN ('current', 'unresolved')`,
    )
    .get([candidateId]);
  if (current !== undefined) return current;
  return connection
    .prepare<CandidateRow>(
      "SELECT reconciliation_candidate_id AS candidate_id, source_listening_event_id AS source_event_id, target_listening_event_id AS target_event_id, source_event_status FROM reconciliation_decision WHERE reconciliation_candidate_id = ? AND decision = 'auto_accept' AND decision_state = 'active' ORDER BY id DESC LIMIT 1",
    )
    .get([candidateId]);
}
function restoreCandidateMerge(connection: SqliteConnection, candidateId: number): void {
  const prior =
    connection
      .prepare<{
        readonly source_listening_event_id: number;
        readonly target_listening_event_id: number;
        readonly source_event_status: "current" | "unresolved";
      }>(
        "SELECT source_listening_event_id, target_listening_event_id, source_event_status FROM manual_reconciliation_decision WHERE reconciliation_candidate_id = ? AND decision = 'accept' ORDER BY rowid DESC LIMIT 1",
      )
      .get([candidateId]) ??
    connection
      .prepare<{
        readonly source_listening_event_id: number;
        readonly target_listening_event_id: number;
        readonly source_event_status: "current" | "unresolved";
      }>(
        "SELECT source_listening_event_id, target_listening_event_id, source_event_status FROM reconciliation_decision WHERE reconciliation_candidate_id = ? AND decision = 'auto_accept' AND decision_state = 'active' ORDER BY id DESC LIMIT 1",
      )
      .get([candidateId]);
  if (prior === undefined || prior.source_listening_event_id === null) return;
  connection
    .prepare(
      "UPDATE listening_event_source SET listening_event_id = ?, evidence_role = 'primary', accepted_match_score = NULL, reconciliation_candidate_id = NULL WHERE listening_event_id = ? AND reconciliation_candidate_id = ?",
    )
    .run([prior.source_listening_event_id, prior.target_listening_event_id, candidateId]);
  connection
    .prepare(
      "UPDATE listening_event SET event_status = ?, superseded_by_event_id = NULL WHERE id = ?",
    )
    .run([prior.source_event_status, prior.source_listening_event_id]);
}

function parseDecision(value: unknown): ManualDecision {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.id) ||
    typeof value.type !== "string" ||
    typeof value.reasonCode !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(value.reasonCode)
  )
    throw new TypeError("Manual decision is invalid");
  if (value.type === "accept" || value.type === "reject") {
    if (!isObject(value.candidate))
      throw new TypeError("Manual reconciliation candidate reference is invalid");
    return {
      id: value.id,
      type: value.type,
      candidate: {
        spotify: parseSourceReference(value.candidate.spotify, "spotify"),
        lastfm: parseSourceReference(value.candidate.lastfm, "lastfm"),
      },
      reasonCode: value.reasonCode,
    };
  }
  if (value.type === "merge" || value.type === "split")
    return {
      id: value.id,
      type: value.type,
      subject: parseEntityReference(value.subject),
      object: parseEntityReference(value.object),
      reasonCode: value.reasonCode,
    };
  if (
    value.type === "alias" &&
    typeof value.alias === "string" &&
    value.alias.length > 0 &&
    value.alias.length <= 500
  )
    return {
      id: value.id,
      type: value.type,
      subject: parseEntityReference(value.subject),
      alias: value.alias,
      reasonCode: value.reasonCode,
    };
  throw new TypeError("Manual decision type is invalid");
}
function parseEntityReference(value: unknown): EntityReference {
  if (
    !isObject(value) ||
    (value.entityType !== "artist" &&
      value.entityType !== "release" &&
      value.entityType !== "track")
  )
    throw new TypeError("Manual entity reference is invalid");
  return { entityType: value.entityType, source: parseSourceReference(value.source) };
}
function parseSourceReference(value: unknown, expected?: "spotify" | "lastfm"): SourceReference {
  if (!isObject(value)) throw new TypeError("Manual source reference is invalid");
  const { sourceKind, sourceFileContentSha256, sourceOrdinal } = value;
  if (
    (sourceKind !== "spotify" && sourceKind !== "lastfm") ||
    (expected !== undefined && sourceKind !== expected) ||
    typeof sourceFileContentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sourceFileContentSha256) ||
    typeof sourceOrdinal !== "number" ||
    !Number.isInteger(sourceOrdinal) ||
    sourceOrdinal < 0
  )
    throw new TypeError("Manual source reference is invalid");
  return { sourceKind, sourceFileContentSha256, sourceOrdinal };
}
function canonicalPayload(value: ManualDecision): string {
  return JSON.stringify(value);
}
function isReconciliationDecision(
  decision: ManualDecision,
): decision is Extract<ManualDecision, { type: "accept" | "reject" }> {
  return decision.type === "accept" || decision.type === "reject";
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sourceReference(
  kind: "spotify" | "lastfm",
  hash: string,
  ordinal: number,
): SourceReference {
  return { sourceKind: kind, sourceFileContentSha256: hash, sourceOrdinal: ordinal };
}
function sourceReferenceParameters(ref: SourceReference): readonly (string | number)[] {
  return [ref.sourceKind, ref.sourceFileContentSha256, ref.sourceOrdinal];
}

const SOURCE_REFERENCE_SQL =
  "SELECT source.id FROM source_record AS source JOIN source_file AS file ON file.id = source.source_file_id WHERE source.source_kind = ? AND file.content_sha256 = ? AND source.source_ordinal = ?";
const CANDIDATE_BY_REFERENCE_SQL = `SELECT candidate.id AS candidate_id FROM reconciliation_candidate AS candidate JOIN source_record AS spotify ON spotify.id = candidate.spotify_source_record_id JOIN source_file AS spotify_file ON spotify_file.id = spotify.source_file_id JOIN source_record AS lastfm ON lastfm.id = candidate.lastfm_source_record_id JOIN source_file AS lastfm_file ON lastfm_file.id = lastfm.source_file_id WHERE spotify.source_kind = ? AND spotify_file.content_sha256 = ? AND spotify.source_ordinal = ? AND lastfm.source_kind = ? AND lastfm_file.content_sha256 = ? AND lastfm.source_ordinal = ?`;
const CANDIDATE_EXPORT_SQL = `SELECT spotify.source_kind AS spotify_kind, spotify_file.content_sha256 AS spotify_hash, spotify.source_ordinal AS spotify_ordinal, lastfm.source_kind AS lastfm_kind, lastfm_file.content_sha256 AS lastfm_hash, lastfm.source_ordinal AS lastfm_ordinal, candidate.candidate_state, candidate.identifier_agreement, candidate.total_confidence FROM reconciliation_candidate AS candidate JOIN source_record AS spotify ON spotify.id = candidate.spotify_source_record_id JOIN source_file AS spotify_file ON spotify_file.id = spotify.source_file_id JOIN source_record AS lastfm ON lastfm.id = candidate.lastfm_source_record_id JOIN source_file AS lastfm_file ON lastfm_file.id = lastfm.source_file_id ORDER BY candidate.id`;
