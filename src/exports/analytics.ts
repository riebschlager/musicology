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

import { generateAbandonmentAnalysis } from "../analytics/abandonment.ts";
import { queryCanonicalAnalyticalBase } from "../analytics/base.ts";
import { generateArtistEraAnalysis } from "../analytics/artist-eras.ts";
import { generateGenreEraAnalysis } from "../analytics/genre-eras.ts";
import { generateRediscoveryAnalysis } from "../analytics/rediscovery.ts";
import { generateVolumeAnalysis } from "../analytics/volume.ts";
import type { JsonObject, JsonValue } from "../cli/result.ts";
import type { SqliteConnection } from "../db/connection.ts";
import { getMigrationStatus } from "../db/migrations.ts";
import { generateGenreContributions } from "../genre/contributions.ts";
import { generateCoverageReport } from "../reporting/coverage.ts";

export const ANALYTICAL_EXPORT_SCHEMA_VERSION = "analytical-export-v2";
export const ANALYTICAL_EXPORT_ARTIFACT_SCHEMA_VERSION = "analytical-export-artifact-v2";
export const ANALYTICAL_EXPORT_DIRECTORY_NAME = "analytics-v2";

const ARTIFACT_NAMES = [
  "volume",
  "artist-eras",
  "genre-eras",
  "rediscovery",
  "abandonment",
  "coverage",
] as const;
export type AnalyticalExportArtifactName = (typeof ARTIFACT_NAMES)[number];

export interface AnalyticalExportDatabaseState extends JsonObject {
  readonly canonicalSnapshotSha256: string;
  readonly genreEvidenceSnapshotSha256: string;
  readonly migrations: readonly {
    readonly checksumSha256: string;
    readonly name: string;
    readonly version: number;
  }[];
}

export interface AnalyticalExportArtifact extends JsonObject {
  readonly artifact: AnalyticalExportArtifactName;
  readonly databaseState: AnalyticalExportDatabaseState;
  readonly data: JsonObject;
  readonly schemaVersion: typeof ANALYTICAL_EXPORT_ARTIFACT_SCHEMA_VERSION;
}

export interface AnalyticalExportManifest extends JsonObject {
  readonly artifacts: Readonly<
    Record<
      AnalyticalExportArtifactName,
      {
        readonly file: string;
        readonly sha256: string;
      }
    >
  >;
  readonly databaseState: AnalyticalExportDatabaseState;
  readonly schemaVersion: typeof ANALYTICAL_EXPORT_SCHEMA_VERSION;
}

export interface GenerateAnalyticalExportsOptions {
  readonly connection: SqliteConnection;
  readonly migrationsDirectory: string;
  readonly presentationTimezone: string;
}

export interface GeneratedAnalyticalExports {
  readonly artifacts: Readonly<Record<AnalyticalExportArtifactName, AnalyticalExportArtifact>>;
  readonly manifest: AnalyticalExportManifest;
}

interface AnalyticalExportFileSystem {
  readonly existsSync: typeof existsSync;
  readonly mkdirSync: typeof mkdirSync;
  readonly mkdtempSync: typeof mkdtempSync;
  readonly renameSync: typeof renameSync;
  readonly rmSync: typeof rmSync;
  readonly writeFileSync: typeof writeFileSync;
}

const nodeFileSystem: AnalyticalExportFileSystem = {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
};

export class AnalyticalExportError extends Error {
  readonly code: "artifact_invalid" | "manifest_invalid" | "stale_export";

  constructor(code: "artifact_invalid" | "manifest_invalid" | "stale_export", message: string) {
    super(message);
    this.name = "AnalyticalExportError";
    this.code = code;
  }
}

/**
 * Produces the six stable web-layer artifacts from canonical analysis and coverage contracts.
 * Source tables are never read into an artifact; coverage is the existing aggregate-only report.
 */
export function generateAnalyticalExports(
  options: GenerateAnalyticalExportsOptions,
): GeneratedAnalyticalExports {
  const coverage = deterministicCoverage(options.connection, options.presentationTimezone);
  const genreEvidence = deterministicGenreEvidence(options);
  const state = databaseState(options, coverage, genreEvidence);
  const data: Readonly<Record<AnalyticalExportArtifactName, JsonObject>> = {
    volume: generateVolumeAnalysis({
      connection: options.connection,
      presentationTimezone: options.presentationTimezone,
    }) as unknown as JsonObject,
    "artist-eras": generateArtistEraAnalysis({
      connection: options.connection,
      presentationTimezone: options.presentationTimezone,
    }) as unknown as JsonObject,
    "genre-eras": generateGenreEraAnalysis({
      connection: options.connection,
      mode: "raw",
      now: () => 0,
      presentationTimezone: options.presentationTimezone,
    }) as unknown as JsonObject,
    rediscovery: generateRediscoveryAnalysis({
      connection: options.connection,
      presentationTimezone: options.presentationTimezone,
    }) as unknown as JsonObject,
    abandonment: generateAbandonmentAnalysis({
      connection: options.connection,
      presentationTimezone: options.presentationTimezone,
    }) as unknown as JsonObject,
    coverage,
  };
  const artifacts = Object.fromEntries(
    ARTIFACT_NAMES.map((artifact) => [
      artifact,
      {
        artifact,
        databaseState: state,
        data: data[artifact],
        schemaVersion: ANALYTICAL_EXPORT_ARTIFACT_SCHEMA_VERSION,
      },
    ]),
  ) as Readonly<Record<AnalyticalExportArtifactName, AnalyticalExportArtifact>>;
  const manifest = createManifest(artifacts, state);
  return { artifacts, manifest };
}

/**
 * Stages a complete bundle beside the published directory, then swaps directories only after the
 * new manifest is present. A write failure leaves the prior verified bundle untouched.
 */
export function writeAnalyticalExports(
  outputDirectory: string,
  generated: GeneratedAnalyticalExports,
  fileSystem: AnalyticalExportFileSystem = nodeFileSystem,
): string {
  const directory = path.join(outputDirectory, ANALYTICAL_EXPORT_DIRECTORY_NAME);
  fileSystem.mkdirSync(outputDirectory, { recursive: true });
  const stagingDirectory = fileSystem.mkdtempSync(`${directory}.staging-`);
  try {
    for (const name of ARTIFACT_NAMES) {
      writeAtomic(
        path.join(stagingDirectory, artifactFileName(name)),
        serializeJson(generated.artifacts[name]),
        fileSystem,
      );
    }
    writeAtomic(
      path.join(stagingDirectory, "manifest.json"),
      serializeJson(generated.manifest),
      fileSystem,
    );
    publishStagedBundle(directory, stagingDirectory, fileSystem);
  } catch (error) {
    removeDirectoryIfPresent(stagingDirectory, fileSystem);
    throw error;
  }
  return directory;
}

/** Validates content hashes and verifies that the manifest describes the current database state. */
export function verifyAnalyticalExports(
  outputDirectory: string,
  options: GenerateAnalyticalExportsOptions,
): AnalyticalExportManifest {
  const directory = path.join(outputDirectory, ANALYTICAL_EXPORT_DIRECTORY_NAME);
  const manifestPath = path.join(directory, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new AnalyticalExportError("manifest_invalid", "Analytical export manifest is missing");
  }
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  const artifacts: Partial<Record<AnalyticalExportArtifactName, AnalyticalExportArtifact>> = {};
  for (const name of ARTIFACT_NAMES) {
    const descriptor = manifest.artifacts[name];
    const artifactPath = path.join(directory, descriptor.file);
    if (!existsSync(artifactPath) || sha256(readFileSync(artifactPath)) !== descriptor.sha256) {
      throw new AnalyticalExportError(
        "manifest_invalid",
        `Analytical export artifact ${name} is invalid`,
      );
    }
    artifacts[name] = parseArtifact(
      readFileSync(artifactPath, "utf8"),
      name,
      manifest.databaseState,
    );
  }
  const current = databaseState(
    options,
    deterministicCoverage(options.connection, options.presentationTimezone),
    deterministicGenreEvidence(options),
  );
  if (serializeJson(manifest.databaseState) !== serializeJson(current)) {
    throw new AnalyticalExportError(
      "stale_export",
      "Analytical exports are stale for the current database state",
    );
  }
  const expected = generateAnalyticalExports(options);
  for (const name of ARTIFACT_NAMES) {
    const artifact = artifacts[name];
    if (
      artifact === undefined ||
      serializeJson(artifact) !== serializeJson(expected.artifacts[name])
    ) {
      throw new AnalyticalExportError(
        "artifact_invalid",
        `Analytical export artifact ${name} does not match its schema and current analysis result`,
      );
    }
  }
  return manifest;
}

function deterministicCoverage(connection: SqliteConnection, timezone: string): JsonObject {
  const { generatedAt: _generatedAt, ...coverage } = generateCoverageReport({
    connection,
    now: () => 0,
    timezone,
  });
  return coverage as unknown as JsonObject;
}

/** Returns the raw-mode evidence consumed by the exported genre-era analysis without exposing it. */
function deterministicGenreEvidence(options: GenerateAnalyticalExportsOptions): JsonObject {
  return generateGenreContributions({
    connection: options.connection,
    mode: "raw",
    now: () => 0,
    presentationTimezone: options.presentationTimezone,
  }) as unknown as JsonObject;
}

function databaseState(
  options: GenerateAnalyticalExportsOptions,
  coverage: JsonObject,
  genreEvidence: JsonObject,
): AnalyticalExportDatabaseState {
  const migrations = getMigrationStatus(
    options.connection,
    options.migrationsDirectory,
  ).applied.map((migration) => ({
    checksumSha256: migration.checksumSha256,
    name: migration.name,
    version: migration.version,
  }));
  const canonicalSnapshot = queryCanonicalAnalyticalBase(
    options.connection,
    options.presentationTimezone,
  ).map((event) => ({
    artistDisplayName: event.artistDisplayName,
    artistId: event.artistId,
    calendarInstantEpochMs: event.calendarInstantEpochMs,
    eventStatus: event.eventStatus,
    listeningEventId: event.listeningEventId,
    reconciliationRuleVersion: event.reconciliationRuleVersion,
    sourceRecordCount: event.sourceRecordCount,
    spotifyDurationMs: event.spotifyDurationMs,
    trackDisplayTitle: event.trackDisplayTitle,
    trackId: event.trackId,
  }));
  return {
    canonicalSnapshotSha256: sha256(serializeJson({ canonicalSnapshot, coverage, migrations })),
    genreEvidenceSnapshotSha256: sha256(serializeJson(genreEvidence)),
    migrations,
  };
}

function createManifest(
  artifacts: Readonly<Record<AnalyticalExportArtifactName, AnalyticalExportArtifact>>,
  databaseState: AnalyticalExportDatabaseState,
): AnalyticalExportManifest {
  return {
    artifacts: Object.fromEntries(
      ARTIFACT_NAMES.map((name) => {
        const file = artifactFileName(name);
        return [name, { file, sha256: sha256(serializeJson(artifacts[name])) }];
      }),
    ) as AnalyticalExportManifest["artifacts"],
    databaseState,
    schemaVersion: ANALYTICAL_EXPORT_SCHEMA_VERSION,
  };
}

function artifactFileName(name: AnalyticalExportArtifactName): string {
  return `${name}.json`;
}

function publishStagedBundle(
  directory: string,
  stagingDirectory: string,
  fileSystem: AnalyticalExportFileSystem,
): void {
  if (!fileSystem.existsSync(directory)) {
    fileSystem.renameSync(stagingDirectory, directory);
    return;
  }

  const previousDirectory = fileSystem.mkdtempSync(`${directory}.previous-`);
  fileSystem.rmSync(previousDirectory, { recursive: true });
  fileSystem.renameSync(directory, previousDirectory);
  try {
    fileSystem.renameSync(stagingDirectory, directory);
  } catch (error) {
    try {
      fileSystem.renameSync(previousDirectory, directory);
    } catch {
      throw new Error("Could not restore the previous analytical export bundle", { cause: error });
    }
    throw error;
  }
  removeDirectoryIfPresent(previousDirectory, fileSystem);
}

function writeAtomic(
  destination: string,
  contents: string,
  fileSystem: AnalyticalExportFileSystem,
): void {
  const temporary = `${destination}.${process.pid}.tmp`;
  fileSystem.writeFileSync(temporary, contents, "utf8");
  fileSystem.renameSync(temporary, destination);
}

function removeDirectoryIfPresent(directory: string, fileSystem: AnalyticalExportFileSystem): void {
  if (fileSystem.existsSync(directory)) {
    fileSystem.rmSync(directory, { force: true, recursive: true });
  }
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function serializeJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const object = value as JsonObject;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortJson(object[key] as JsonValue)]),
    );
  }
  return value;
}

function parseManifest(text: string): AnalyticalExportManifest {
  const value = parseJsonObject(text, "manifest_invalid");
  if (
    value.schemaVersion !== ANALYTICAL_EXPORT_SCHEMA_VERSION ||
    !isDatabaseState(value.databaseState)
  ) {
    throw new AnalyticalExportError(
      "manifest_invalid",
      "Analytical export manifest has an unsupported schema",
    );
  }
  if (!isPlainObject(value.artifacts)) {
    throw new AnalyticalExportError(
      "manifest_invalid",
      "Analytical export manifest is missing artifacts",
    );
  }
  for (const name of ARTIFACT_NAMES) {
    const descriptor = value.artifacts[name];
    if (
      !isPlainObject(descriptor) ||
      descriptor.file !== artifactFileName(name) ||
      !isSha256(descriptor.sha256)
    ) {
      throw new AnalyticalExportError(
        "manifest_invalid",
        "Analytical export manifest has an invalid artifact",
      );
    }
  }
  return value as unknown as AnalyticalExportManifest;
}

function parseArtifact(
  text: string,
  expectedName: AnalyticalExportArtifactName,
  expectedState: AnalyticalExportDatabaseState,
): AnalyticalExportArtifact {
  const value = parseJsonObject(text, "artifact_invalid");
  if (
    value.schemaVersion !== ANALYTICAL_EXPORT_ARTIFACT_SCHEMA_VERSION ||
    value.artifact !== expectedName ||
    !isPlainObject(value.data) ||
    !isDatabaseState(value.databaseState) ||
    serializeJson(value.databaseState) !== serializeJson(expectedState)
  ) {
    throw new AnalyticalExportError(
      "artifact_invalid",
      `Analytical export artifact ${expectedName} has an unsupported schema`,
    );
  }
  return value as unknown as AnalyticalExportArtifact;
}

function parseJsonObject(text: string, code: "artifact_invalid" | "manifest_invalid"): JsonObject {
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) throw new Error("not an object");
    return value as JsonObject;
  } catch {
    throw new AnalyticalExportError(code, "Analytical export JSON is invalid");
  }
}

function isDatabaseState(value: unknown): value is AnalyticalExportDatabaseState {
  return (
    isPlainObject(value) &&
    isSha256(value.canonicalSnapshotSha256) &&
    isSha256(value.genreEvidenceSnapshotSha256) &&
    Array.isArray(value.migrations) &&
    value.migrations.every(
      (migration) =>
        isPlainObject(migration) &&
        typeof migration.version === "number" &&
        typeof migration.name === "string" &&
        isSha256(migration.checksumSha256),
    )
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
