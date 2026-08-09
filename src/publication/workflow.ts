import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  PUBLIC_ARTIFACT_FIELD_ALLOWLIST,
  PUBLIC_ARTIFACT_FILES,
  PUBLIC_GENERATION_VERSION,
  PUBLIC_MANIFEST_SCHEMA_VERSION,
  PUBLIC_REVIEW_REPORT_SCHEMA_VERSION,
  validatePublicArtifact,
  validatePublicManifest,
  validatePublicReviewReport,
  type PublicManifest,
  type PublicReviewReport,
} from "./contract.ts";
import { PUBLIC_SELECTION_POLICY_VERSION } from "./policy.ts";
import type { ProjectedPublicSnapshot } from "./projection.ts";

export const PUBLIC_MANIFEST_FILE = "manifest.json";
export const PUBLIC_REVIEW_REPORT_FILE = "review-report.json";
export const PUBLIC_APPROVAL_FILE = "approval.json";
export const ACTIVE_PUBLIC_SNAPSHOT_FILE = "active.json";
export const ACTIVE_PUBLIC_SNAPSHOT_SCHEMA_VERSION = "active-public-snapshot-v1";
export const PUBLIC_APPROVAL_SCHEMA_VERSION = "public-approval-v1";

const ZERO_SHA256 = "0".repeat(64);
const REQUIRED_ARTIFACTS = ["artists", "editorial", "history", "stories"] as const;
type RequiredPublicArtifact = (typeof REQUIRED_ARTIFACTS)[number];

export interface PublicationFileSystem {
  readonly existsSync: typeof existsSync;
  readonly mkdirSync: typeof mkdirSync;
  readonly mkdtempSync: typeof mkdtempSync;
  readonly readFileSync: typeof readFileSync;
  readonly renameSync: typeof renameSync;
  readonly rmSync: typeof rmSync;
  readonly writeFileSync: typeof writeFileSync;
}

const nodeFileSystem: PublicationFileSystem = {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
};

export interface BuiltPublicCandidate {
  readonly artifactBytes: Readonly<Record<RequiredPublicArtifact, string>>;
  readonly manifest: PublicManifest;
  readonly manifestBytes: string;
  readonly report: PublicReviewReport;
  readonly reportBytes: string;
}

export interface StoredPublicSnapshot extends BuiltPublicCandidate {}

export interface ActivePublicSnapshotPointer {
  readonly manifestSha256: string;
  readonly schemaVersion: typeof ACTIVE_PUBLIC_SNAPSHOT_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
}

export class PublicationWorkflowError extends Error {
  readonly code:
    | "approval_conflict"
    | "candidate_invalid"
    | "candidate_write_failed"
    | "snapshot_invalid"
    | "snapshot_missing";

  constructor(code: PublicationWorkflowError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublicationWorkflowError";
    this.code = code;
  }
}

/**
 * The report binds a candidate-manifest preimage with reportSha256 zeroed. The final manifest then
 * binds the exact report bytes. Approval reuses the same preimage after normalizing approval-only
 * state, avoiding a circular self-hash while preserving an exact review binding.
 */
export function buildPublicCandidate(
  snapshot: ProjectedPublicSnapshot,
  generatedOn: string,
  previousApprovedDirectory?: string,
): BuiltPublicCandidate {
  validateOperationalDate(generatedOn, "Candidate generation date");
  const artifactBytes = Object.fromEntries(
    REQUIRED_ARTIFACTS.map((name) => [name, serializePublicJson(snapshot.artifacts[name])]),
  ) as unknown as BuiltPublicCandidate["artifactBytes"];
  const artifactReferences = Object.fromEntries(
    REQUIRED_ARTIFACTS.map((name) => [
      name,
      { file: PUBLIC_ARTIFACT_FILES[name], sha256: sha256(artifactBytes[name]) },
    ]),
  ) as Record<RequiredPublicArtifact, { file: string; sha256: string }>;
  const previous =
    previousApprovedDirectory === undefined
      ? null
      : readStoredPublicSnapshot(previousApprovedDirectory);
  if (previous !== null && previous.manifest.state !== "approved") {
    throw new PublicationWorkflowError(
      "snapshot_invalid",
      "Previous public snapshot is not approved",
    );
  }
  const snapshotSha256 = calculateSnapshotSha256(artifactReferences);
  const baseManifest: PublicManifest = {
    analyticalVersions: snapshot.analyticalVersions,
    approval: null,
    artifacts: {
      artists: artifactReferences.artists,
      editorial: artifactReferences.editorial,
      genreLab: null,
      history: artifactReferences.history,
      stories: artifactReferences.stories,
    },
    asOfDate: snapshot.asOfDate,
    coverage: snapshot.coverage,
    downloads: [],
    generationVersion: PUBLIC_GENERATION_VERSION,
    publicationDate: null,
    publicationPolicy: {
      artwork: "project_owned_or_licensed_only",
      externalRequests: "same_origin_only",
      fonts: "system_only",
      visitorAnalytics: "none",
    },
    reportSha256: ZERO_SHA256,
    schemaVersion: PUBLIC_MANIFEST_SCHEMA_VERSION,
    selectionPolicyVersion: PUBLIC_SELECTION_POLICY_VERSION,
    snapshotId: snapshot.snapshotId,
    snapshotSha256,
    state: "candidate",
    supersedesSnapshotId: previous?.manifest.snapshotId ?? null,
    timezone: snapshot.timezone,
  };
  const candidateManifestSha256 = candidateManifestBindingSha256(baseManifest);
  const summaries = REQUIRED_ARTIFACTS.map((name) =>
    artifactSummary(name, snapshot.artifacts[name].data, artifactReferences[name]),
  );
  const previousSlugs = previous === null ? [] : allPublicSlugs(previous.report);
  const currentSlugs = uniqueSorted(summaries.flatMap((summary) => summary.publicSlugs));
  const changedArtifacts = REQUIRED_ARTIFACTS.filter((name) => {
    if (previous === null) return true;
    return previous.manifest.artifacts[name].sha256 !== artifactReferences[name].sha256;
  }).toSorted(compareText);
  const report: PublicReviewReport = {
    analyticalVersions: snapshot.analyticalVersions,
    artifactSummaries: summaries,
    asOfDate: snapshot.asOfDate,
    candidateManifestSha256,
    changeSummary: {
      addedPublicSlugs: currentSlugs.filter((slug) => !previousSlugs.includes(slug)),
      changedArtifacts,
      removedPublicSlugs: previousSlugs.filter((slug) => !currentSlugs.includes(slug)),
      selectionPolicyChanged:
        previous !== null &&
        previous.manifest.selectionPolicyVersion !== PUBLIC_SELECTION_POLICY_VERSION,
    },
    coverage: snapshot.coverage,
    generatedOn,
    previousSnapshotId: previous?.manifest.snapshotId ?? null,
    schemaVersion: PUBLIC_REVIEW_REPORT_SCHEMA_VERSION,
    selectionPolicyVersion: PUBLIC_SELECTION_POLICY_VERSION,
    snapshotId: snapshot.snapshotId,
  };
  validatePublicReviewReport(report);
  const reportBytes = serializePublicJson(report);
  const manifest = validatePublicManifest({ ...baseManifest, reportSha256: sha256(reportBytes) });
  const manifestBytes = serializePublicJson(manifest);
  return { artifactBytes, manifest, manifestBytes, report, reportBytes };
}

/** Stages every candidate file and swaps only after the complete staging tree validates. */
export function writePublicCandidate(
  candidatesDirectory: string,
  candidate: BuiltPublicCandidate,
  fileSystem: PublicationFileSystem = nodeFileSystem,
): string {
  const destination = path.join(candidatesDirectory, candidate.manifest.snapshotId);
  fileSystem.mkdirSync(candidatesDirectory, { recursive: true });
  const staging = fileSystem.mkdtempSync(`${destination}.staging-`);
  try {
    writeSnapshotFiles(staging, candidate, fileSystem);
    readStoredPublicSnapshot(staging, fileSystem);
    publishStagedDirectory(destination, staging, true, fileSystem);
    return destination;
  } catch (error) {
    tryRemoveDirectory(staging, fileSystem);
    if (error instanceof PublicationWorkflowError && error.code !== "snapshot_invalid") throw error;
    throw new PublicationWorkflowError(
      "candidate_write_failed",
      "Public candidate staging failed; the prior candidate was retained",
      { cause: error },
    );
  }
}

/** Copies reviewed artifacts/report unchanged; only approval metadata and manifest state differ. */
export function approvePublicCandidate(
  candidateDirectory: string,
  publicationDirectory: string,
  decidedOn: string,
  fileSystem: PublicationFileSystem = nodeFileSystem,
): string {
  validateOperationalDate(decidedOn, "Approval date");
  const candidate = readStoredPublicSnapshot(candidateDirectory, fileSystem);
  if (candidate.manifest.state !== "candidate") {
    throw new PublicationWorkflowError(
      "candidate_invalid",
      "Only a candidate snapshot can be approved",
    );
  }
  const approvedDirectory = path.join(
    publicationDirectory,
    "approved",
    candidate.manifest.snapshotId,
  );
  if (fileSystem.existsSync(approvedDirectory)) {
    throw new PublicationWorkflowError(
      "approval_conflict",
      "Approved snapshots are immutable and the target snapshot already exists",
    );
  }
  const approvedManifest = validatePublicManifest({
    ...candidate.manifest,
    approval: {
      decidedOn,
      decision: "approved",
      reportSha256: candidate.manifest.reportSha256,
    },
    publicationDate: decidedOn,
    state: "approved",
  });
  const approved: StoredPublicSnapshot = {
    ...candidate,
    manifest: approvedManifest,
    manifestBytes: serializePublicJson(approvedManifest),
  };
  const approval = {
    decidedOn,
    decision: "approved",
    reportSha256: candidate.manifest.reportSha256,
    schemaVersion: PUBLIC_APPROVAL_SCHEMA_VERSION,
    snapshotId: candidate.manifest.snapshotId,
    snapshotSha256: candidate.manifest.snapshotSha256,
  } as const;
  fileSystem.mkdirSync(path.dirname(approvedDirectory), { recursive: true });
  const staging = fileSystem.mkdtempSync(`${approvedDirectory}.staging-`);
  try {
    writeSnapshotFiles(staging, approved, fileSystem);
    fileSystem.writeFileSync(
      path.join(staging, PUBLIC_APPROVAL_FILE),
      serializePublicJson(approval),
      "utf8",
    );
    readStoredPublicSnapshot(staging, fileSystem);
    publishStagedDirectory(approvedDirectory, staging, false, fileSystem);
    return approvedDirectory;
  } catch (error) {
    tryRemoveDirectory(staging, fileSystem);
    if (error instanceof PublicationWorkflowError && error.code === "approval_conflict")
      throw error;
    throw new PublicationWorkflowError(
      "candidate_write_failed",
      "Public approval staging failed; no approved snapshot was replaced",
      { cause: error },
    );
  }
}

/** Repointing to a retained approved snapshot is rollback; it performs no private-data work. */
export function activateApprovedPublicSnapshot(
  publicationDirectory: string,
  snapshotId: string,
  fileSystem: PublicationFileSystem = nodeFileSystem,
): string {
  const approvedDirectory = path.join(publicationDirectory, "approved", snapshotId);
  const snapshot = readStoredPublicSnapshot(approvedDirectory, fileSystem);
  if (snapshot.manifest.state !== "approved" || snapshot.manifest.snapshotId !== snapshotId) {
    throw new PublicationWorkflowError(
      "snapshot_invalid",
      "Active snapshot target is not approved",
    );
  }
  const pointer: ActivePublicSnapshotPointer = {
    manifestSha256: sha256(snapshot.manifestBytes),
    schemaVersion: ACTIVE_PUBLIC_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    snapshotSha256: snapshot.manifest.snapshotSha256,
  };
  fileSystem.mkdirSync(publicationDirectory, { recursive: true });
  const destination = path.join(publicationDirectory, ACTIVE_PUBLIC_SNAPSHOT_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fileSystem.writeFileSync(temporary, serializePublicJson(pointer), "utf8");
    fileSystem.renameSync(temporary, destination);
  } catch (error) {
    if (fileSystem.existsSync(temporary)) fileSystem.rmSync(temporary, { force: true });
    throw new PublicationWorkflowError(
      "candidate_write_failed",
      "Active public snapshot pointer was not changed",
      { cause: error },
    );
  }
  return destination;
}

export function readActivePublicSnapshot(
  publicationDirectory: string,
): ActivePublicSnapshotPointer {
  try {
    const value: unknown = JSON.parse(
      readFileSync(path.join(publicationDirectory, ACTIVE_PUBLIC_SNAPSHOT_FILE), "utf8"),
    );
    if (!isPlainObject(value)) invalidSnapshot();
    const keys = ["manifestSha256", "schemaVersion", "snapshotId", "snapshotSha256"];
    if (
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !(key in value)) ||
      value.schemaVersion !== ACTIVE_PUBLIC_SNAPSHOT_SCHEMA_VERSION ||
      !isSha256(value.manifestSha256) ||
      !isSha256(value.snapshotSha256) ||
      typeof value.snapshotId !== "string"
    ) {
      invalidSnapshot();
    }
    const pointer = value as unknown as ActivePublicSnapshotPointer;
    const snapshot = readStoredPublicSnapshot(
      path.join(publicationDirectory, "approved", pointer.snapshotId),
    );
    if (
      snapshot.manifest.state !== "approved" ||
      sha256(snapshot.manifestBytes) !== pointer.manifestSha256 ||
      snapshot.manifest.snapshotSha256 !== pointer.snapshotSha256
    ) {
      invalidSnapshot();
    }
    return pointer;
  } catch (error) {
    if (error instanceof PublicationWorkflowError) throw error;
    throw new PublicationWorkflowError("snapshot_missing", "Active public snapshot is missing");
  }
}

export function readStoredPublicSnapshot(
  directory: string,
  fileSystem: PublicationFileSystem = nodeFileSystem,
): StoredPublicSnapshot {
  if (!fileSystem.existsSync(path.join(directory, PUBLIC_MANIFEST_FILE))) {
    throw new PublicationWorkflowError("snapshot_missing", "Public snapshot manifest is missing");
  }
  try {
    const manifestBytes = fileSystem.readFileSync(
      path.join(directory, PUBLIC_MANIFEST_FILE),
      "utf8",
    );
    const manifest = validatePublicManifest(JSON.parse(manifestBytes));
    const reportBytes = fileSystem.readFileSync(
      path.join(directory, PUBLIC_REVIEW_REPORT_FILE),
      "utf8",
    );
    const report = validatePublicReviewReport(JSON.parse(reportBytes));
    if (
      sha256(reportBytes) !== manifest.reportSha256 ||
      report.snapshotId !== manifest.snapshotId ||
      report.previousSnapshotId !== manifest.supersedesSnapshotId ||
      report.candidateManifestSha256 !== candidateManifestBindingSha256(manifest)
    ) {
      invalidSnapshot();
    }
    const parsedArtifacts = new Map<RequiredPublicArtifact, unknown>();
    const artifactBytes = Object.fromEntries(
      REQUIRED_ARTIFACTS.map((name) => {
        const reference = manifest.artifacts[name];
        const bytes = fileSystem.readFileSync(path.join(directory, reference.file), "utf8");
        const artifact = validatePublicArtifact(JSON.parse(bytes));
        if (
          sha256(bytes) !== reference.sha256 ||
          artifact.artifact !== name ||
          artifact.snapshotId !== manifest.snapshotId ||
          serializePublicJson(artifact.coverage) !== serializePublicJson(manifest.coverage) ||
          serializePublicJson(artifact.analyticalVersions) !==
            serializePublicJson(manifest.analyticalVersions) ||
          artifact.timezone !== manifest.timezone ||
          artifact.asOfDate !== manifest.asOfDate
        ) {
          invalidSnapshot();
        }
        parsedArtifacts.set(name, artifact.data);
        return [name, bytes];
      }),
    ) as unknown as StoredPublicSnapshot["artifactBytes"];
    const references = Object.fromEntries(
      REQUIRED_ARTIFACTS.map((name) => [name, manifest.artifacts[name]]),
    ) as Record<RequiredPublicArtifact, { readonly file: string; readonly sha256: string }>;
    if (calculateSnapshotSha256(references) !== manifest.snapshotSha256) invalidSnapshot();
    const summaries = REQUIRED_ARTIFACTS.map((name) =>
      artifactSummary(name, parsedArtifacts.get(name), references[name]),
    );
    if (serializePublicJson(summaries) !== serializePublicJson(report.artifactSummaries)) {
      invalidSnapshot();
    }
    validateCrossArtifactReferences(parsedArtifacts);
    if (manifest.state === "approved") validateApprovalFile(directory, manifest, fileSystem);
    return { artifactBytes, manifest, manifestBytes, report, reportBytes };
  } catch (error) {
    if (error instanceof PublicationWorkflowError) throw error;
    throw new PublicationWorkflowError(
      "snapshot_invalid",
      "Public snapshot files failed closed validation",
      { cause: error },
    );
  }
}

function writeSnapshotFiles(
  directory: string,
  snapshot: BuiltPublicCandidate,
  fileSystem: PublicationFileSystem,
): void {
  for (const name of REQUIRED_ARTIFACTS) {
    fileSystem.writeFileSync(
      path.join(directory, PUBLIC_ARTIFACT_FILES[name]),
      snapshot.artifactBytes[name],
      "utf8",
    );
  }
  fileSystem.writeFileSync(
    path.join(directory, PUBLIC_REVIEW_REPORT_FILE),
    snapshot.reportBytes,
    "utf8",
  );
  fileSystem.writeFileSync(
    path.join(directory, PUBLIC_MANIFEST_FILE),
    snapshot.manifestBytes,
    "utf8",
  );
}

function validateApprovalFile(
  directory: string,
  manifest: PublicManifest,
  fileSystem: PublicationFileSystem,
): void {
  const value: unknown = JSON.parse(
    fileSystem.readFileSync(path.join(directory, PUBLIC_APPROVAL_FILE), "utf8"),
  );
  if (!isPlainObject(value)) invalidSnapshot();
  const expected = {
    decidedOn: manifest.approval?.decidedOn,
    decision: "approved",
    reportSha256: manifest.reportSha256,
    schemaVersion: PUBLIC_APPROVAL_SCHEMA_VERSION,
    snapshotId: manifest.snapshotId,
    snapshotSha256: manifest.snapshotSha256,
  };
  if (serializePublicJson(value) !== serializePublicJson(expected)) invalidSnapshot();
}

function artifactSummary(
  name: RequiredPublicArtifact,
  data: unknown,
  reference: { readonly file: string; readonly sha256: string },
): PublicReviewReport["artifactSummaries"][number] {
  if (!isPlainObject(data)) invalidSnapshot();
  const records =
    name === "history"
      ? arrayValue(data.periods)
      : name === "artists"
        ? arrayValue(data.artists)
        : name === "stories"
          ? arrayValue(data.stories)
          : [...arrayValue(data.annotations), ...arrayValue(data.featuredArtists)];
  return {
    artifact: name,
    fieldAllowlist: PUBLIC_ARTIFACT_FIELD_ALLOWLIST[name],
    file: reference.file,
    publicSlugs: publicSlugsForArtifact(name, data),
    recordCount: records.length,
    sha256: reference.sha256,
  };
}

function publicSlugsForArtifact(
  name: RequiredPublicArtifact,
  data: Record<string, unknown>,
): readonly string[] {
  if (name === "history") return [];
  if (name === "artists") {
    return uniqueSorted(arrayValue(data.artists).map((item) => stringProperty(item, "slug")));
  }
  if (name === "stories") {
    return uniqueSorted(
      arrayValue(data.stories).flatMap((item) => {
        if (!isPlainObject(item)) invalidSnapshot();
        const selected = item.selectedTrack;
        return [
          stringProperty(item, "slug"),
          ...(selected === null ? [] : [stringProperty(selected, "slug")]),
        ];
      }),
    );
  }
  return uniqueSorted(
    [...arrayValue(data.annotations), ...arrayValue(data.featuredArtists)].map((item) =>
      stringProperty(item, "slug"),
    ),
  );
}

function validateCrossArtifactReferences(
  artifacts: ReadonlyMap<RequiredPublicArtifact, unknown>,
): void {
  const artists = objectProperty(artifacts.get("artists"), "artists");
  const stories = objectProperty(artifacts.get("stories"), "stories");
  const editorial = artifacts.get("editorial");
  if (!isPlainObject(editorial)) invalidSnapshot();
  const artistSlugs = new Set(artists.map((artist) => stringProperty(artist, "slug")));
  const storySlugs = new Set(stories.map((story) => stringProperty(story, "slug")));
  for (const story of stories) {
    if (!isPlainObject(story)) invalidSnapshot();
    if (story.artistSlug !== null && !artistSlugs.has(stringValue(story.artistSlug))) {
      invalidSnapshot();
    }
    if (
      story.supersedesStorySlug !== null &&
      !storySlugs.has(stringValue(story.supersedesStorySlug))
    ) {
      invalidSnapshot();
    }
  }
  for (const featured of objectProperty(editorial, "featuredArtists")) {
    if (!artistSlugs.has(stringProperty(featured, "artistSlug"))) invalidSnapshot();
    if (arrayProperty(featured, "storySlugs").some((slug) => !storySlugs.has(stringValue(slug)))) {
      invalidSnapshot();
    }
  }
}

function allPublicSlugs(report: PublicReviewReport): readonly string[] {
  return uniqueSorted(report.artifactSummaries.flatMap((summary) => summary.publicSlugs));
}

function candidateManifestBindingSha256(manifest: PublicManifest): string {
  return sha256(
    serializePublicJson({
      ...manifest,
      approval: null,
      publicationDate: null,
      reportSha256: ZERO_SHA256,
      state: "candidate",
    }),
  );
}

function calculateSnapshotSha256(
  references: Record<RequiredPublicArtifact, { readonly file: string; readonly sha256: string }>,
): string {
  return sha256(
    serializePublicJson(
      REQUIRED_ARTIFACTS.map((name) => ({
        artifact: name,
        file: references[name].file,
        sha256: references[name].sha256,
      })),
    ),
  );
}

function publishStagedDirectory(
  destination: string,
  staging: string,
  replace: boolean,
  fileSystem: PublicationFileSystem,
): void {
  if (!fileSystem.existsSync(destination)) {
    fileSystem.renameSync(staging, destination);
    return;
  }
  if (!replace) {
    throw new PublicationWorkflowError("approval_conflict", "Approved snapshots are immutable");
  }
  const previous = fileSystem.mkdtempSync(`${destination}.previous-`);
  fileSystem.rmSync(previous, { recursive: true });
  fileSystem.renameSync(destination, previous);
  try {
    fileSystem.renameSync(staging, destination);
  } catch (error) {
    try {
      fileSystem.renameSync(previous, destination);
    } catch {
      throw new PublicationWorkflowError(
        "candidate_write_failed",
        "Candidate replacement failed and the prior candidate could not be restored",
        { cause: error },
      );
    }
    throw error;
  }
  // The replacement is committed once staging has been renamed to the destination. A failure to
  // remove the retained backup must not turn that committed success into a reported failure.
  tryRemoveDirectory(previous, fileSystem);
}

function removeDirectory(directory: string, fileSystem: PublicationFileSystem): void {
  if (fileSystem.existsSync(directory)) {
    fileSystem.rmSync(directory, { force: true, recursive: true });
  }
}

function tryRemoveDirectory(directory: string, fileSystem: PublicationFileSystem): void {
  try {
    removeDirectory(directory, fileSystem);
  } catch {
    // A staging or prior-version directory is recoverable residue. The destination state is the
    // transaction outcome and must not be misreported because best-effort cleanup failed.
  }
}

function objectProperty(value: unknown, key: string): readonly unknown[] {
  if (!isPlainObject(value)) invalidSnapshot();
  return arrayValue(value[key]);
}

function arrayProperty(value: unknown, key: string): readonly unknown[] {
  if (!isPlainObject(value)) invalidSnapshot();
  return arrayValue(value[key]);
}

function stringProperty(value: unknown, key: string): string {
  if (!isPlainObject(value)) invalidSnapshot();
  return stringValue(value[key]);
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") invalidSnapshot();
  return value;
}

function arrayValue(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalidSnapshot();
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function invalidSnapshot(): never {
  throw new PublicationWorkflowError("snapshot_invalid", "Public snapshot files are inconsistent");
}

function validateOperationalDate(value: string, label: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10) !== value
  ) {
    throw new PublicationWorkflowError("candidate_invalid", `${label} must use YYYY-MM-DD`);
  }
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].toSorted(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function serializePublicJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}
