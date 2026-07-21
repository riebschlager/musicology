import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "../../../src/db/migrations.ts";
import { withTemporarySqliteDatabase } from "../../../src/db/temporary.ts";
import { createCanonicalEvents } from "../../../src/identity/events.ts";
import { resolveSourceIdentities } from "../../../src/identity/resolution.ts";
import { generateCrossSourceCandidates } from "../../../src/reconciliation/candidates.ts";
import { calculateCrossSourceMatchFeatures } from "../../../src/reconciliation/features.ts";
import {
  exportManualReview,
  importManualDecisions,
  parseManualDecisionArtifact,
} from "../../../src/reconciliation/manual-decisions.ts";
import { applyReconciliationDecisions } from "../../../src/reconciliation/apply.ts";

const migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const spotifyHash = "1".repeat(64);
const lastfmHash = "2".repeat(64);
const fingerprint = (digit: string) => digit.repeat(64);
type Connection = Parameters<typeof importManualDecisions>[0];

function seed(connection: Connection): void {
  connection
    .prepare(
      "INSERT INTO ingest_run (id, command_type, started_at_epoch_ms, status, completed_at_epoch_ms, schema_version) VALUES (1, 'identity_resolution', 1, 'succeeded', 1, '9')",
    )
    .run();
  connection
    .prepare(
      "INSERT INTO source_file (id, relative_path, source_type, byte_size, content_sha256, first_ingest_run_id, last_ingest_run_id) VALUES (1, 'synthetic/spotify.json', 'spotify_export', 1, ?, 1, 1), (2, 'lastfm/export.json', 'lastfm_export', 1, ?, 1, 1)",
    )
    .run([spotifyHash, lastfmHash]);
  connection
    .prepare(
      "INSERT INTO source_record (id, source_kind, ingest_run_id, source_file_id, source_ordinal, accepted_at_epoch_ms) VALUES (1, 'spotify', 1, 1, 0, 1), (2, 'lastfm', 1, 2, 0, 1), (3, 'spotify', 1, 1, 1, 1)",
    )
    .run();
  connection
    .prepare(
      "INSERT INTO spotify_play_source (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri, artist_name, track_name, shuffle, source_fingerprint_sha256) VALUES (1, 160000, 60000, 'spotify:track:synthetic', 'Synthetic Artist', 'Synthetic Track', 0, ?)",
    )
    .run([fingerprint("3")]);
  connection
    .prepare(
      "INSERT INTO spotify_play_source (source_record_id, stopped_at_epoch_ms, ms_played, spotify_track_uri, artist_name, track_name, shuffle, source_fingerprint_sha256) VALUES (3, 360000, 60000, 'spotify:track:other', 'Other Artist', 'Other Track', 0, ?)",
    )
    .run([fingerprint("5")]);
  connection
    .prepare(
      "INSERT INTO lastfm_scrobble_source (source_record_id, source_origin, scrobbled_at_epoch_ms, artist_name, track_name, source_fingerprint_sha256) VALUES (2, 'export', 100000, 'Synthetic Artist', 'Synthetic Track', ?)",
    )
    .run([fingerprint("4")]);
  connection
    .prepare(
      "INSERT INTO lastfm_scrobble_occurrence (source_record_id, lastfm_scrobble_source_record_id, source_origin) VALUES (2, 2, 'export')",
    )
    .run();
  resolveSourceIdentities(connection, { now: () => 2 });
  createCanonicalEvents(connection);
  generateCrossSourceCandidates(connection, { now: () => 3 });
  calculateCrossSourceMatchFeatures(connection);
}

const acceptArtifact = () =>
  parseManualDecisionArtifact({
    artifactVersion: "manual-decisions-v1",
    decisions: [
      {
        id: "accept-synthetic-pair",
        type: "accept",
        reasonCode: "reviewed_match",
        candidate: {
          spotify: {
            sourceKind: "spotify",
            sourceFileContentSha256: spotifyHash,
            sourceOrdinal: 0,
          },
          lastfm: { sourceKind: "lastfm", sourceFileContentSha256: lastfmHash, sourceOrdinal: 0 },
        },
      },
    ],
  });

function acceptedDecision() {
  const decision = acceptArtifact().decisions[0];
  if (decision === undefined || decision.type !== "accept") {
    throw new Error("Synthetic artifact must contain one acceptance decision");
  }
  return decision;
}

describe("manual reconciliation decision artifacts", () => {
  it("round-trips an accepted candidate onto a rebuilt synthetic database without duplication", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      seed(connection);
      assert.deepEqual(importManualDecisions(connection, acceptArtifact(), 4), {
        imported: 1,
        alreadyApplied: 0,
        backupRequired: true,
      });
      const exported = exportManualReview(connection);
      assert.deepEqual(exported.decisions, [
        JSON.parse(JSON.stringify(acceptArtifact().decisions[0])),
      ]);
      assert.equal(
        connection.prepare("SELECT candidate_state FROM reconciliation_candidate").get()
          ?.candidate_state,
        "manually_accepted",
      );
      assert.equal(
        connection
          .prepare("SELECT count(*) AS count FROM listening_event WHERE event_status = 'current'")
          .get()?.count,
        2,
      );
      assert.equal(applyReconciliationDecisions(connection, { now: () => 5 }).autoAccepted, 0);
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM reconciliation_decision").get()?.count,
        0,
      );
      assert.deepEqual(importManualDecisions(connection, acceptArtifact(), 5), {
        imported: 0,
        alreadyApplied: 1,
        backupRequired: true,
      });
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM manual_decision_artifact").get()?.count,
        1,
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      seed(connection);
      assert.equal(importManualDecisions(connection, acceptArtifact(), 4).imported, 1);
      assert.equal(
        connection.prepare("SELECT candidate_state FROM reconciliation_candidate").get()
          ?.candidate_state,
        "manually_accepted",
      );
    });
  });

  it("rejects stale references before writing any decision", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      seed(connection);
      const stale = parseManualDecisionArtifact({
        artifactVersion: "manual-decisions-v1",
        decisions: [
          {
            ...acceptArtifact().decisions[0],
            id: "stale-pair",
            candidate: {
              spotify: {
                sourceKind: "spotify",
                sourceFileContentSha256: "f".repeat(64),
                sourceOrdinal: 0,
              },
              lastfm: {
                sourceKind: "lastfm",
                sourceFileContentSha256: lastfmHash,
                sourceOrdinal: 0,
              },
            },
          },
        ],
      });
      assert.throws(() => importManualDecisions(connection, stale, 4), /stale candidate/);
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM manual_decision_artifact").get()?.count,
        0,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM manual_reconciliation_decision").get()
          ?.count,
        0,
      );
    });
  });

  it("rolls back every earlier decision when a later bulk-artifact reference is stale", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      seed(connection);
      const accepted = acceptedDecision();
      const artifact = parseManualDecisionArtifact({
        artifactVersion: "manual-decisions-v1",
        decisions: [
          accepted,
          {
            ...accepted,
            id: "stale-after-valid-decision",
            candidate: {
              spotify: {
                sourceKind: "spotify",
                sourceFileContentSha256: "f".repeat(64),
                sourceOrdinal: 0,
              },
              lastfm: {
                sourceKind: "lastfm",
                sourceFileContentSha256: lastfmHash,
                sourceOrdinal: 0,
              },
            },
          },
        ],
      });

      assert.throws(() => importManualDecisions(connection, artifact, 4), /stale candidate/);
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM manual_decision_artifact").get()?.count,
        0,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM manual_reconciliation_decision").get()
          ?.count,
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
        3,
      );
    });
  });

  it("lets a manual rejection restore an automatic merge and override later policy runs", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      seed(connection);
      connection.prepare("UPDATE reconciliation_candidate SET total_confidence = 0.97").run();
      assert.equal(applyReconciliationDecisions(connection, { now: () => 4 }).autoAccepted, 1);

      const rejection = parseManualDecisionArtifact({
        artifactVersion: "manual-decisions-v1",
        decisions: [
          {
            ...acceptedDecision(),
            id: "reject-automatic-synthetic-pair",
            type: "reject",
            reasonCode: "reviewed_non_match",
          },
        ],
      });
      importManualDecisions(connection, rejection, 5);

      assert.equal(
        connection.prepare("SELECT candidate_state FROM reconciliation_candidate").get()
          ?.candidate_state,
        "manually_rejected",
      );
      assert.equal(
        connection
          .prepare("SELECT count(*) AS count FROM listening_event WHERE event_status = 'current'")
          .get()?.count,
        3,
      );
      assert.equal(applyReconciliationDecisions(connection, { now: () => 6 }).autoAccepted, 0);
      assert.equal(
        connection.prepare("SELECT candidate_state FROM reconciliation_candidate").get()
          ?.candidate_state,
        "manually_rejected",
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });

  it("imports auditable merge and artist-alias directives", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      seed(connection);
      const artist = (sourceOrdinal: number) => ({
        entityType: "artist" as const,
        source: {
          sourceKind: "spotify" as const,
          sourceFileContentSha256: spotifyHash,
          sourceOrdinal,
        },
      });
      const artifact = parseManualDecisionArtifact({
        artifactVersion: "manual-decisions-v1",
        decisions: [
          {
            id: "merge-synthetic-artists",
            type: "merge",
            reasonCode: "reviewed_identity",
            subject: artist(0),
            object: artist(1),
          },
          {
            id: "alias-synthetic-artist",
            type: "alias",
            reasonCode: "reviewed_alias",
            subject: artist(0),
            alias: "Synthetic Alias",
          },
        ],
      });
      assert.deepEqual(importManualDecisions(connection, artifact, 4), {
        imported: 2,
        alreadyApplied: 0,
        backupRequired: true,
      });
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM identity_decision").get()?.count,
        2,
      );
      assert.equal(
        connection
          .prepare("SELECT count(*) AS count FROM artist_alias WHERE alias_source = 'manual'")
          .get()?.count,
        1,
      );
      assert.equal(
        connection.prepare("SELECT count(*) AS count FROM manual_identity_decision").get()?.count,
        2,
      );
    });
  });

  it("applies a directed artist merge and restores its exact prior interpretation on split", () => {
    withTemporarySqliteDatabase(({ connection }) => {
      applyMigrations(connection, migrationsDirectory);
      seed(connection);
      const artist = (sourceOrdinal: number) => ({
        entityType: "artist" as const,
        source: {
          sourceKind: "spotify" as const,
          sourceFileContentSha256: spotifyHash,
          sourceOrdinal,
        },
      });
      const merge = parseManualDecisionArtifact({
        artifactVersion: "manual-decisions-v1",
        decisions: [
          {
            id: "merge-restorable-artists",
            type: "merge",
            reasonCode: "reviewed_identity",
            subject: artist(0),
            object: artist(1),
          },
        ],
      });
      importManualDecisions(connection, merge, 4);
      assert.deepEqual(
        connection
          .prepare(
            "SELECT resolution.artist_id, track.artist_id AS track_artist_id FROM source_identity_resolution AS resolution JOIN track ON track.id = resolution.track_id WHERE resolution.source_record_id = 3",
          )
          .get(),
        connection
          .prepare(
            "SELECT resolution.artist_id, track.artist_id AS track_artist_id FROM source_identity_resolution AS resolution JOIN track ON track.id = resolution.track_id WHERE resolution.source_record_id = 1",
          )
          .get(),
      );

      const split = parseManualDecisionArtifact({
        artifactVersion: "manual-decisions-v1",
        decisions: [
          {
            id: "split-restorable-artists",
            type: "split",
            reasonCode: "reviewed_identity",
            subject: artist(0),
            object: artist(1),
          },
        ],
      });
      importManualDecisions(connection, split, 5);
      assert.notEqual(
        connection
          .prepare("SELECT artist_id FROM source_identity_resolution WHERE source_record_id = 3")
          .get()?.artist_id,
        connection
          .prepare("SELECT artist_id FROM source_identity_resolution WHERE source_record_id = 1")
          .get()?.artist_id,
      );
      assert.equal(connection.checkIntegrity().ok, true);
    });
  });
});
