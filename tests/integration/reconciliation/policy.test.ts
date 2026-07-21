import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import {
  CALIBRATION_SAMPLE_VERSION,
  CROSS_SOURCE_DECISION_POLICY,
  CROSS_SOURCE_DECISION_POLICY_VERSION,
  classifyReconciliationCandidate,
  exportCalibrationSample,
} from "../../../src/reconciliation/policy.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

function fingerprint(id: number): string {
  return id.toString(16).padStart(64, "0");
}

function insertCandidate(
  connection: Parameters<typeof exportCalibrationSample>[0],
  id: number,
  options: {
    readonly competingCandidateScore: number;
    readonly identifierAgreement: 0 | 1 | null;
    readonly totalConfidence: number;
  },
): void {
  connection
    .prepare(
      "INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '7')",
    )
    .run();
  const spotifyId = id * 10;
  const lastfmId = spotifyId + 1;
  connection
    .prepare(
      "INSERT INTO source_record (id, source_kind, ingest_run_id, accepted_at_epoch_ms) VALUES (?, 'spotify', 1, 1), (?, 'lastfm', 1, 1)",
    )
    .run([spotifyId, lastfmId]);
  connection
    .prepare(
      `INSERT INTO spotify_play_source
        (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri, artist_name,
         track_name, shuffle, source_fingerprint_sha256)
       VALUES (?, 1000, 1000, ?, 'Synthetic Artist', 'Synthetic Track', 0, ?)`,
    )
    .run([spotifyId, `spotify:track:synthetic-${String(id)}`, fingerprint(spotifyId)]);
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_source
        (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name,
         source_fingerprint_sha256)
       VALUES (?, 'export', 1000, 'Synthetic Artist', 'Synthetic Track', ?)`,
    )
    .run([lastfmId, fingerprint(lastfmId)]);
  connection
    .prepare(
      `INSERT INTO reconciliation_candidate
        (spotify_source_record_id, lastfm_source_record_id, identifier_agreement, artist_score,
         track_score, start_delta_ms, ambiguity_score, competing_candidate_score,
         short_play_score, total_confidence, rule_version, candidate_state)
       VALUES (?, ?, ?, 1, 1, 0, 0, ?, 1, ?, 'cross-source-match-feature-v1', 'pending')`,
    )
    .run([
      spotifyId,
      lastfmId,
      options.identifierAgreement,
      options.competingCandidateScore,
      options.totalConfidence,
    ]);
}

describe("cross-source decision policy", () => {
  it("uses conservative thresholds while hard conflicts and ambiguity override confidence", () => {
    assert.equal(
      classifyReconciliationCandidate({
        identifierAgreement: 1,
        competingCandidateScore: 1,
        totalConfidence: 0.95,
      }),
      "auto_accept",
    );
    assert.equal(
      classifyReconciliationCandidate({
        identifierAgreement: null,
        competingCandidateScore: 1,
        totalConfidence: 0.7,
      }),
      "review",
    );
    assert.equal(
      classifyReconciliationCandidate({
        identifierAgreement: null,
        competingCandidateScore: 1,
        totalConfidence: 0.699999,
      }),
      "ignore",
    );
    assert.equal(
      classifyReconciliationCandidate({
        identifierAgreement: 0,
        competingCandidateScore: 1,
        totalConfidence: 1,
      }),
      "review",
    );
    assert.equal(
      classifyReconciliationCandidate({
        identifierAgreement: 1,
        competingCandidateScore: 0.5,
        totalConfidence: 1,
      }),
      "review",
    );
  });

  it("exports deterministic privacy-safe strata without raw source values", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertCandidate(connection, 1, {
        identifierAgreement: 1,
        competingCandidateScore: 1,
        totalConfidence: 0.99,
      });
      insertCandidate(connection, 2, {
        identifierAgreement: 0,
        competingCandidateScore: 1,
        totalConfidence: 0.99,
      });
      insertCandidate(connection, 3, {
        identifierAgreement: null,
        competingCandidateScore: 0.5,
        totalConfidence: 0.99,
      });
      insertCandidate(connection, 4, {
        identifierAgreement: null,
        competingCandidateScore: 1,
        totalConfidence: 0.8,
      });
      insertCandidate(connection, 5, {
        identifierAgreement: null,
        competingCandidateScore: 1,
        totalConfidence: 0.2,
      });

      const sample = exportCalibrationSample(connection, { perStratum: 1 });
      assert.equal(sample.sampleVersion, CALIBRATION_SAMPLE_VERSION);
      assert.equal(sample.policy.version, CROSS_SOURCE_DECISION_POLICY_VERSION);
      assert.equal(sample.policy.featureRuleVersion, "cross-source-match-feature-v1");
      assert.deepEqual(
        sample.candidates.map((candidate) => [candidate.candidateId, candidate.proposedDecision]),
        [
          [3, "review"],
          [1, "auto_accept"],
          [5, "ignore"],
          [4, "review"],
          [2, "review"],
        ],
      );
      assert.deepEqual(Object.keys(sample).sort(), [
        "candidates",
        "featureRuleVersion",
        "policy",
        "sampleVersion",
      ]);
      assert.deepEqual(Object.keys(sample.candidates[0] ?? {}).sort(), [
        "candidateId",
        "competingCandidateScore",
        "identifierAgreement",
        "label",
        "lastfmSourceRecordId",
        "proposedDecision",
        "spotifySourceRecordId",
        "totalConfidence",
      ]);
      const serializedSample = JSON.stringify(sample);
      for (const forbiddenSourceValue of [
        "Synthetic Artist",
        "Synthetic Track",
        "spotify:track:synthetic-1",
        fingerprint(10),
        fingerprint(11),
        "1000",
      ]) {
        assert.equal(serializedSample.includes(forbiddenSourceValue), false);
      }
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

  it("uses a stable hash permutation instead of selecting the earliest candidate IDs", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      for (let id = 1; id <= 10; id += 1) {
        insertCandidate(connection, id, {
          identifierAgreement: 1,
          competingCandidateScore: 1,
          totalConfidence: 0.99,
        });
      }

      const first = exportCalibrationSample(connection, { perStratum: 1 });
      const second = exportCalibrationSample(connection, { perStratum: 1 });

      assert.deepEqual(first, second);
      assert.equal(first.candidates.length, 1);
      assert.notEqual(first.candidates[0]?.candidateId, 1);
    });
  });

  it("keeps a policy version coupled to its feature version, thresholds, and rationale", () => {
    assert.deepEqual(CROSS_SOURCE_DECISION_POLICY, {
      featureRuleVersion: "cross-source-match-feature-v1",
      highConfidenceThreshold: 0.95,
      ignoreThreshold: 0.7,
      rationale:
        "A false merge erases a listening-history distinction, so automatic acceptance requires very high aggregate confidence, no strong-identifier disagreement, and exactly one compatible candidate on each side. Candidates below the review threshold are retained as ignored rather than treated as evidence of non-matching identity.",
      version: "cross-source-decision-policy-v1",
    });
  });
});
