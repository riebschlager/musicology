import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import { createCanonicalEvents } from "../../../src/identity/events.ts";
import { resolveSourceIdentities } from "../../../src/identity/resolution.ts";
import { applyReconciliationDecisions } from "../../../src/reconciliation/apply.ts";
import { generateCrossSourceCandidates } from "../../../src/reconciliation/candidates.ts";
import { calculateCrossSourceMatchFeatures } from "../../../src/reconciliation/features.ts";
import { CROSS_SOURCE_DECISION_POLICY } from "../../../src/reconciliation/policy.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));

function fingerprint(id: number): string {
  return id.toString(16).padStart(64, "0");
}

type Connection = Parameters<typeof applyReconciliationDecisions>[0];

function insertPair(connection: Connection, spotifyId = 1, lastfmId = 2): void {
  connection
    .prepare(
      "INSERT OR IGNORE INTO ingest_run (id, command_type, started_at_epoch_ms, status, schema_version) VALUES (1, 'identity_resolution', 1, 'running', '8')",
    )
    .run();
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
       VALUES (?, 160000, 60000, ?, 'Synthetic Artist', 'Synthetic Track', 0, ?)`,
    )
    .run([spotifyId, `spotify:track:${String(spotifyId)}`, fingerprint(spotifyId)]);
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_source
        (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name,
         source_fingerprint_sha256)
       VALUES (?, 'export', 100000, 'Synthetic Artist', 'Synthetic Track', ?)`,
    )
    .run([lastfmId, fingerprint(lastfmId)]);
  connection
    .prepare(
      `INSERT INTO lastfm_scrobble_occurrence
        (source_record_id, lastfm_scrobble_source_record_id, source_origin)
       VALUES (?, ?, 'export')`,
    )
    .run([lastfmId, lastfmId]);
  resolveSourceIdentities(connection, { now: () => 2 });
  createCanonicalEvents(connection);
  generateCrossSourceCandidates(connection, { now: () => 3 });
  calculateCrossSourceMatchFeatures(connection);
}

describe("reconciliation decision application", () => {
  it("dry-runs without writes, then merges an explainable high-confidence pair and is idempotent", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertPair(connection);
      connection.prepare("UPDATE reconciliation_candidate SET total_confidence = 0.97").run();

      const dryRun = applyReconciliationDecisions(connection, { dryRun: true, now: () => 4 });
      assert.deepEqual(dryRun, {
        autoAccepted: 1,
        ignored: 0,
        review: 0,
        skipped: 0,
        supersededAutomaticDecisions: 0,
        dryRun: true,
        policyRuleVersion: "cross-source-decision-policy-v1",
      });
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM reconciliation_decision").get()?.count,
        0,
      );
      assert.equal(
        connection
          .prepare("SELECT count(*) AS count FROM listening_event WHERE event_status = 'current'")
          .get()?.count,
        2,
      );

      assert.equal(applyReconciliationDecisions(connection, { now: () => 5 }).autoAccepted, 1);
      assert.deepEqual(
        connection
          .prepare(
            `SELECT candidate.candidate_state, decision.decision, decision.policy_rule_version,
                  link.evidence_role, link.accepted_match_score, link.reconciliation_candidate_id
             FROM reconciliation_candidate AS candidate
             JOIN reconciliation_decision AS decision ON decision.reconciliation_candidate_id = candidate.id
             JOIN listening_event_source AS link ON link.reconciliation_candidate_id = candidate.id`,
          )
          .get(),
        {
          candidate_state: "auto_accepted",
          decision: "auto_accept",
          policy_rule_version: "cross-source-decision-policy-v1",
          evidence_role: "cross_source_match",
          accepted_match_score: 0.97,
          reconciliation_candidate_id: 1,
        },
      );
      assert.equal(
        connection
          .prepare("SELECT count(*) AS count FROM listening_event WHERE event_status = 'current'")
          .get()?.count,
        1,
      );
      assert.deepEqual(applyReconciliationDecisions(connection, { now: () => 6 }), {
        autoAccepted: 0,
        ignored: 0,
        review: 0,
        skipped: 0,
        supersededAutomaticDecisions: 0,
        dryRun: false,
        policyRuleVersion: "cross-source-decision-policy-v1",
      });
      const revisedPolicy = {
        ...CROSS_SOURCE_DECISION_POLICY,
        highConfidenceThreshold: 0.98,
        version: "cross-source-decision-policy-v2",
      };
      assert.deepEqual(
        applyReconciliationDecisions(connection, { now: () => 7, policy: revisedPolicy }),
        {
          autoAccepted: 0,
          ignored: 0,
          review: 1,
          skipped: 0,
          supersededAutomaticDecisions: 1,
          dryRun: false,
          policyRuleVersion: "cross-source-decision-policy-v2",
        },
      );
      assert.deepEqual(
        connection
          .prepare(
            `SELECT policy_rule_version, decision, decision_state, superseded_by_decision_id
               FROM reconciliation_decision
              ORDER BY id`,
          )
          .all(),
        [
          {
            policy_rule_version: "cross-source-decision-policy-v1",
            decision: "auto_accept",
            decision_state: "superseded",
            superseded_by_decision_id: 2,
          },
          {
            policy_rule_version: "cross-source-decision-policy-v2",
            decision: "review",
            decision_state: "active",
            superseded_by_decision_id: null,
          },
        ],
      );
      assert.deepEqual(
        connection
          .prepare(
            "SELECT candidate_state, resolved_at_epoch_ms, resolution_rationale FROM reconciliation_candidate",
          )
          .get(),
        { candidate_state: "pending", resolved_at_epoch_ms: null, resolution_rationale: null },
      );
      assert.equal(
        connection
          .prepare("SELECT count(*) AS count FROM listening_event WHERE event_status = 'current'")
          .get()?.count,
        2,
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

  it("keeps ambiguous and identifier-conflicting pairs separate and records low confidence separately", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertPair(connection);
      connection.prepare("UPDATE reconciliation_candidate SET identifier_agreement = 0").run();
      assert.equal(applyReconciliationDecisions(connection, { now: () => 4 }).review, 1);
      assert.equal(
        connection
          .prepare("SELECT count(*) AS count FROM listening_event WHERE event_status = 'current'")
          .get()?.count,
        2,
      );

      connection
        .prepare(
          "UPDATE reconciliation_candidate SET identifier_agreement = NULL, total_confidence = 0.2",
        )
        .run();
      const result = applyReconciliationDecisions(connection, {
        now: () => 5,
        policy: { ...CROSS_SOURCE_DECISION_POLICY, version: "cross-source-decision-policy-v2" },
      });
      assert.equal(result.ignored, 1);
      assert.equal(
        connection.prepare("SELECT candidate_state FROM reconciliation_candidate").get()
          ?.candidate_state,
        "auto_rejected",
      );
      assert.equal(
        connection
          .prepare("SELECT count(*) AS count FROM listening_event WHERE event_status = 'current'")
          .get()?.count,
        2,
      );
    });
  });

  it("uses the selected policy thresholds when applying a later policy version", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertPair(connection);
      connection.prepare("UPDATE reconciliation_candidate SET total_confidence = 0.97").run();

      const result = applyReconciliationDecisions(connection, {
        now: () => 4,
        policy: {
          ...CROSS_SOURCE_DECISION_POLICY,
          highConfidenceThreshold: 0.98,
          version: "cross-source-decision-policy-v2",
        },
      });

      assert.equal(result.review, 1);
      assert.equal(result.autoAccepted, 0);
      assert.equal(
        connection
          .prepare("SELECT count(*) AS count FROM listening_event WHERE event_status = 'current'")
          .get()?.count,
        2,
      );
      assert.equal(
        connection.prepare("SELECT decision FROM reconciliation_decision").get()?.decision,
        "review",
      );
    });
  });

  it("rolls back decision and event writes if a merge is interrupted", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      insertPair(connection);
      connection.execute(`CREATE TRIGGER fail_reconcile_merge
        BEFORE UPDATE OF listening_event_id ON listening_event_source
        BEGIN SELECT RAISE(ABORT, 'synthetic reconciliation failure'); END`);

      assert.throws(
        () => applyReconciliationDecisions(connection, { now: () => 4 }),
        /synthetic reconciliation failure/,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM reconciliation_decision").get()?.count,
        0,
      );
      assert.equal(
        connection.prepare("SELECT candidate_state FROM reconciliation_candidate").get()
          ?.candidate_state,
        "pending",
      );
      assert.equal(
        connection
          .prepare("SELECT count(*) AS count FROM listening_event WHERE event_status = 'current'")
          .get()?.count,
        2,
      );
    });
  });
});
