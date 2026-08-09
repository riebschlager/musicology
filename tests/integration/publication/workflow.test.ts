import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PUBLIC_ARTIFACT_FILES } from "../../../src/publication/contract.ts";
import { loadPrivateAnalyticalBundle } from "../../../src/publication/private-bundle.ts";
import { projectPublicSnapshot } from "../../../src/publication/projection.ts";
import {
  ACTIVE_PUBLIC_SNAPSHOT_FILE,
  PUBLIC_APPROVAL_FILE,
  PUBLIC_MANIFEST_FILE,
  PUBLIC_REVIEW_REPORT_FILE,
  PublicationWorkflowError,
  activateApprovedPublicSnapshot,
  approvePublicCandidate,
  buildPublicCandidate,
  readActivePublicSnapshot,
  readStoredPublicSnapshot,
  writePublicCandidate,
  type PublicationFileSystem,
} from "../../../src/publication/workflow.ts";
import {
  emptyPublicationInput,
  syntheticDatabaseState,
  syntheticPublicationInput,
  writeSyntheticPrivateBundle,
} from "../../fixtures/publication.ts";

const generatedOn = "2026-08-09";
const approvedOn = "2026-08-10";

function withWorkspace(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "musicology-p6-04-workflow-"));
  try {
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function buildFixtureCandidate(
  root: string,
  snapshotId = "snapshot-2026-08-09-fixture",
  empty = false,
) {
  const privateDirectory = path.join(root, `private-${snapshotId}`);
  writeSyntheticPrivateBundle(privateDirectory, { empty });
  const bundle = loadPrivateAnalyticalBundle(privateDirectory, syntheticDatabaseState);
  const projected = projectPublicSnapshot(
    bundle,
    empty ? emptyPublicationInput(snapshotId) : syntheticPublicationInput(snapshotId),
  );
  return { candidate: buildPublicCandidate(projected, generatedOn), privateDirectory, projected };
}

describe("P6-04 publication candidate, approval, and rollback workflow", () => {
  it("keeps the committed full and empty public snapshots byte-for-byte reproducible", () => {
    withWorkspace((root) => {
      const fixtureRoot = fileURLToPath(
        new URL("../../fixtures/public-snapshots/", import.meta.url),
      );
      const cases = [
        ["full", "snapshot-2026-08-09-fixture", false],
        ["empty", "snapshot-2026-08-09-empty", true],
      ] as const;
      for (const [name, snapshotId, empty] of cases) {
        const generated = buildFixtureCandidate(root, snapshotId, empty).candidate;
        const committed = readStoredPublicSnapshot(path.join(fixtureRoot, name));
        assert.deepEqual(committed, generated);
      }
    });
  });

  it("produces deterministic bytes, filenames, hashes, and a human-reviewable report", () => {
    withWorkspace((root) => {
      const { candidate, projected } = buildFixtureCandidate(root);
      const rerun = buildPublicCandidate(projected, generatedOn);
      assert.deepEqual(rerun, candidate);

      const candidateDirectory = writePublicCandidate(path.join(root, "candidates"), candidate);
      const stored = readStoredPublicSnapshot(candidateDirectory);
      assert.deepEqual(stored, candidate);
      assert.deepEqual(
        readDirectoryNames(candidateDirectory),
        [
          PUBLIC_ARTIFACT_FILES.artists,
          PUBLIC_ARTIFACT_FILES.editorial,
          PUBLIC_ARTIFACT_FILES.history,
          PUBLIC_MANIFEST_FILE,
          PUBLIC_REVIEW_REPORT_FILE,
          PUBLIC_ARTIFACT_FILES.stories,
        ].toSorted(),
      );
      assert.deepEqual(
        candidate.report.artifactSummaries.map((summary) => ({
          artifact: summary.artifact,
          count: summary.recordCount,
          slugs: summary.publicSlugs,
        })),
        [
          { artifact: "artists", count: 1, slugs: ["synthetic-eligible-artist"] },
          {
            artifact: "editorial",
            count: 2,
            slugs: ["synthetic-annotation", "synthetic-feature"],
          },
          { artifact: "history", count: 12, slugs: [] },
          {
            artifact: "stories",
            count: 2,
            slugs: ["synthetic-dormancy", "synthetic-rediscovery", "wholly-manual-selected-track"],
          },
        ],
      );
      assert.equal(candidate.report.asOfDate, "2021-01-01");
      assert.equal(candidate.report.coverage.dateRange?.startPeriod, "2020-01");
      assert.equal(candidate.report.coverage.dateRange?.endPeriodExclusive, "2021-01");
      assert.equal(candidate.report.analyticalVersions.length, 4);
      assert.equal(
        candidate.report.artifactSummaries.every((summary) => summary.fieldAllowlist.length > 0),
        true,
      );
    });
  });

  it("retains the prior complete candidate when staging fails", () => {
    withWorkspace((root) => {
      const candidatesDirectory = path.join(root, "candidates");
      const { candidate } = buildFixtureCandidate(root);
      const destination = writePublicCandidate(candidatesDirectory, candidate);
      const priorManifest = readFileSync(path.join(destination, PUBLIC_MANIFEST_FILE), "utf8");
      const priorHistory = readFileSync(
        path.join(destination, PUBLIC_ARTIFACT_FILES.history),
        "utf8",
      );
      let writes = 0;
      const failingFileSystem: PublicationFileSystem = {
        existsSync,
        mkdirSync,
        mkdtempSync,
        readFileSync,
        renameSync,
        rmSync,
        writeFileSync: ((...args: Parameters<typeof writeFileSync>) => {
          writes += 1;
          if (writes === 2) throw new Error("synthetic staging failure");
          return writeFileSync(...args);
        }) as typeof writeFileSync,
      };

      assert.throws(
        () => writePublicCandidate(candidatesDirectory, candidate, failingFileSystem),
        (error: unknown) =>
          error instanceof PublicationWorkflowError && error.code === "candidate_write_failed",
      );
      assert.equal(
        readFileSync(path.join(destination, PUBLIC_MANIFEST_FILE), "utf8"),
        priorManifest,
      );
      assert.equal(
        readFileSync(path.join(destination, PUBLIC_ARTIFACT_FILES.history), "utf8"),
        priorHistory,
      );
    });
  });

  it("restores a prior candidate when the replacement rename fails", () => {
    withWorkspace((root) => {
      const candidatesDirectory = path.join(root, "candidates");
      const { candidate, projected } = buildFixtureCandidate(root);
      const destination = writePublicCandidate(candidatesDirectory, candidate);
      const priorManifest = readFileSync(path.join(destination, PUBLIC_MANIFEST_FILE), "utf8");
      const replacement = buildPublicCandidate(projected, "2026-08-11");
      const failingFileSystem: PublicationFileSystem = {
        existsSync,
        mkdirSync,
        mkdtempSync,
        readFileSync,
        renameSync: ((
          source: Parameters<typeof renameSync>[0],
          target: Parameters<typeof renameSync>[1],
        ) => {
          if (String(source).includes(".staging-") && String(target) === destination) {
            throw new Error("synthetic replacement rename failure");
          }
          return renameSync(source, target);
        }) as typeof renameSync,
        rmSync,
        writeFileSync,
      };

      assert.throws(
        () => writePublicCandidate(candidatesDirectory, replacement, failingFileSystem),
        (error: unknown) =>
          error instanceof PublicationWorkflowError && error.code === "candidate_write_failed",
      );
      assert.equal(
        readFileSync(path.join(destination, PUBLIC_MANIFEST_FILE), "utf8"),
        priorManifest,
      );
      assert.deepEqual(readStoredPublicSnapshot(destination), candidate);
    });
  });

  it("reports committed replacement success when only prior-backup cleanup fails", () => {
    withWorkspace((root) => {
      const candidatesDirectory = path.join(root, "candidates");
      const { candidate, projected } = buildFixtureCandidate(root);
      const destination = writePublicCandidate(candidatesDirectory, candidate);
      const replacement = buildPublicCandidate(projected, "2026-08-11");
      let removals = 0;
      const cleanupFailingFileSystem: PublicationFileSystem = {
        existsSync,
        mkdirSync,
        mkdtempSync,
        readFileSync,
        renameSync,
        rmSync: ((...args: Parameters<typeof rmSync>) => {
          removals += 1;
          if (removals === 2) throw new Error("synthetic prior-backup cleanup failure");
          return rmSync(...args);
        }) as typeof rmSync,
        writeFileSync,
      };

      assert.equal(
        writePublicCandidate(candidatesDirectory, replacement, cleanupFailingFileSystem),
        destination,
      );
      assert.deepEqual(readStoredPublicSnapshot(destination), replacement);
    });
  });

  it("fails closed on tampering before approval and preserves reviewed bytes on approval", () => {
    withWorkspace((root) => {
      const { candidate } = buildFixtureCandidate(root);
      const candidateDirectory = writePublicCandidate(path.join(root, "candidates"), candidate);
      const historyPath = path.join(candidateDirectory, PUBLIC_ARTIFACT_FILES.history);
      const reviewedHistory = readFileSync(historyPath, "utf8");
      const reviewedReport = readFileSync(
        path.join(candidateDirectory, PUBLIC_REVIEW_REPORT_FILE),
        "utf8",
      );
      writeFileSync(
        historyPath,
        reviewedHistory.replace('"data":{', '"data":{"ipAddress":"private",'),
      );
      assert.throws(
        () =>
          approvePublicCandidate(candidateDirectory, path.join(root, "publication"), approvedOn),
        (error: unknown) =>
          error instanceof PublicationWorkflowError && error.code === "snapshot_invalid",
      );

      writeFileSync(historyPath, reviewedHistory, "utf8");
      const publicationDirectory = path.join(root, "publication");
      const approvedDirectory = approvePublicCandidate(
        candidateDirectory,
        publicationDirectory,
        approvedOn,
      );
      const approved = readStoredPublicSnapshot(approvedDirectory);
      assert.equal(approved.manifest.state, "approved");
      assert.equal(approved.manifest.publicationDate, approvedOn);
      assert.equal(approved.manifest.approval?.reportSha256, candidate.manifest.reportSha256);
      assert.equal(
        readFileSync(path.join(approvedDirectory, PUBLIC_ARTIFACT_FILES.history), "utf8"),
        reviewedHistory,
      );
      assert.equal(
        readFileSync(path.join(approvedDirectory, PUBLIC_REVIEW_REPORT_FILE), "utf8"),
        reviewedReport,
      );
      assert.equal(existsSync(path.join(approvedDirectory, PUBLIC_APPROVAL_FILE)), true);
      assert.throws(
        () => approvePublicCandidate(candidateDirectory, publicationDirectory, approvedOn),
        (error: unknown) =>
          error instanceof PublicationWorkflowError && error.code === "approval_conflict",
      );
    });
  });

  it("records supersession and rolls back by repointing retained approved data without private inputs", () => {
    withWorkspace((root) => {
      const publicationDirectory = path.join(root, "publication");
      const candidatesDirectory = path.join(root, "candidates");
      const first = buildFixtureCandidate(root, "snapshot-2026-08-09-first");
      const firstCandidateDirectory = writePublicCandidate(candidatesDirectory, first.candidate);
      const firstApprovedDirectory = approvePublicCandidate(
        firstCandidateDirectory,
        publicationDirectory,
        approvedOn,
      );

      const secondProjection = projectPublicSnapshot(
        loadPrivateAnalyticalBundle(first.privateDirectory, syntheticDatabaseState),
        syntheticPublicationInput("snapshot-2026-08-09-second"),
      );
      const secondCandidate = buildPublicCandidate(
        secondProjection,
        "2026-08-11",
        firstApprovedDirectory,
      );
      assert.equal(secondCandidate.manifest.supersedesSnapshotId, first.projected.snapshotId);
      assert.equal(secondCandidate.report.previousSnapshotId, first.projected.snapshotId);
      const secondCandidateDirectory = writePublicCandidate(candidatesDirectory, secondCandidate);
      const secondApprovedDirectory = approvePublicCandidate(
        secondCandidateDirectory,
        publicationDirectory,
        "2026-08-12",
      );
      assert.equal(existsSync(firstApprovedDirectory), true);
      assert.equal(existsSync(secondApprovedDirectory), true);

      activateApprovedPublicSnapshot(publicationDirectory, secondProjection.snapshotId);
      assert.equal(
        readActivePublicSnapshot(publicationDirectory).snapshotId,
        secondProjection.snapshotId,
      );
      const activePath = path.join(publicationDirectory, ACTIVE_PUBLIC_SNAPSHOT_FILE);
      const activeBytes = readFileSync(activePath, "utf8");
      const active = JSON.parse(activeBytes) as Record<string, unknown>;
      writeFileSync(activePath, JSON.stringify({ ...active, snapshotSha256: "0".repeat(64) }));
      assert.throws(
        () => readActivePublicSnapshot(publicationDirectory),
        (error: unknown) =>
          error instanceof PublicationWorkflowError && error.code === "snapshot_invalid",
      );
      writeFileSync(activePath, activeBytes, "utf8");
      rmSync(first.privateDirectory, { force: true, recursive: true });
      assert.equal(findDatabaseFiles(root).length, 0);
      activateApprovedPublicSnapshot(publicationDirectory, first.projected.snapshotId);
      assert.equal(
        readActivePublicSnapshot(publicationDirectory).snapshotId,
        first.projected.snapshotId,
      );
      assert.equal(readStoredPublicSnapshot(firstApprovedDirectory).manifest.state, "approved");
      assert.equal(existsSync(path.join(publicationDirectory, ACTIVE_PUBLIC_SNAPSHOT_FILE)), true);
    });
  });
});

function readDirectoryNames(directory: string): string[] {
  return readdirSync(directory).toSorted();
}

function findDatabaseFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => /\.(?:db|sqlite|sqlite3)$/u.test(name));
}
