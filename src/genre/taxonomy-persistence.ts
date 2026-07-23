import { createHash } from "node:crypto";

import type { SqliteConnection, SqliteRow } from "../db/connection.ts";
import {
  canonicalizeGenreTaxonomyArtifact,
  parseGenreTaxonomyArtifact,
  type GenreTaxonomyArtifact,
  type GenreTaxonomyCategory,
} from "./taxonomy.ts";

interface TextRow extends SqliteRow {
  readonly value: string;
}

interface CategoryRow extends SqliteRow {
  readonly category_id: string;
  readonly label: string;
  readonly parent_category_id: string | null;
}

interface MappingRow extends SqliteRow {
  readonly action: "keep" | "combine" | "rename" | "ignore";
  readonly source_tag: string;
  readonly target_category_id: string | null;
}

export interface GenreTaxonomyImportSummary {
  readonly taxonomyVersion: string;
  readonly imported: boolean;
}

function stableArtifactJson(artifact: GenreTaxonomyArtifact): string {
  return JSON.stringify(canonicalizeGenreTaxonomyArtifact(artifact));
}

function fingerprint(artifact: GenreTaxonomyArtifact): string {
  return createHash("sha256").update(stableArtifactJson(artifact)).digest("hex");
}

function validateKnownSourceTags(
  connection: SqliteConnection,
  artifact: GenreTaxonomyArtifact,
): void {
  const known = new Set(
    connection
      .prepare<TextRow>("SELECT DISTINCT normalized_raw_tag AS value FROM genre_enrichment_raw_tag")
      .all()
      .map((row) => row.value),
  );
  const unknown = artifact.mappings.find((mapping) => !known.has(mapping.sourceTag));
  if (unknown !== undefined)
    throw new TypeError("Genre taxonomy mapping references an unknown raw tag");
}

function categoriesInParentFirstOrder(
  categories: readonly GenreTaxonomyCategory[],
): readonly GenreTaxonomyCategory[] {
  const pending = new Map(categories.map((category) => [category.id, category]));
  const ordered: GenreTaxonomyCategory[] = [];

  while (pending.size > 0) {
    let inserted = false;
    for (const [id, category] of pending) {
      if (category.parentId !== null && pending.has(category.parentId)) continue;
      ordered.push(category);
      pending.delete(id);
      inserted = true;
    }
    if (!inserted) {
      throw new TypeError("Genre taxonomy category hierarchy cannot be persisted");
    }
  }

  return ordered;
}

/** Imports a new immutable taxonomy version; raw provider evidence is intentionally never modified. */
export function importGenreTaxonomy(
  connection: SqliteConnection,
  value: unknown,
  importedAtEpochMs = Date.now(),
): GenreTaxonomyImportSummary {
  const artifact = parseGenreTaxonomyArtifact(value);
  if (!Number.isSafeInteger(importedAtEpochMs) || importedAtEpochMs < 0) {
    throw new TypeError("Genre taxonomy import time is invalid");
  }
  return connection.transaction(() => {
    validateKnownSourceTags(connection, artifact);
    const contentFingerprint = fingerprint(artifact);
    const existing = connection
      .prepare<TextRow>(
        "SELECT content_fingerprint_sha256 AS value FROM genre_taxonomy_version WHERE taxonomy_version = ?",
      )
      .get([artifact.taxonomyVersion]);
    if (existing !== undefined) {
      if (existing.value !== contentFingerprint) {
        throw new TypeError("Changed genre taxonomy content requires a new taxonomy version");
      }
      return { taxonomyVersion: artifact.taxonomyVersion, imported: false };
    }
    connection
      .prepare(
        "INSERT INTO genre_taxonomy_version (taxonomy_version, artifact_version, content_fingerprint_sha256, imported_at_epoch_ms) VALUES (?, ?, ?, ?)",
      )
      .run([
        artifact.taxonomyVersion,
        artifact.artifactVersion,
        contentFingerprint,
        importedAtEpochMs,
      ]);
    const insertCategory = connection.prepare(
      "INSERT INTO genre_taxonomy_category (taxonomy_version, category_id, label, parent_category_id) VALUES (?, ?, ?, ?)",
    );
    for (const category of categoriesInParentFirstOrder(artifact.categories)) {
      insertCategory.run([
        artifact.taxonomyVersion,
        category.id,
        category.label,
        category.parentId,
      ]);
    }
    const insertMapping = connection.prepare(
      "INSERT INTO genre_taxonomy_mapping (taxonomy_version, source_tag, mapping_action, target_category_id) VALUES (?, ?, ?, ?)",
    );
    for (const mapping of artifact.mappings) {
      insertMapping.run([
        artifact.taxonomyVersion,
        mapping.sourceTag,
        mapping.action,
        mapping.targetCategoryId,
      ]);
    }
    return { taxonomyVersion: artifact.taxonomyVersion, imported: true };
  });
}

/** Exports one exact, deterministic portable taxonomy artifact. */
export function exportGenreTaxonomy(
  connection: SqliteConnection,
  taxonomyVersion: string,
): GenreTaxonomyArtifact {
  const version = connection
    .prepare<TextRow>(
      "SELECT artifact_version AS value FROM genre_taxonomy_version WHERE taxonomy_version = ?",
    )
    .get([taxonomyVersion]);
  if (version?.value === undefined) throw new TypeError("Genre taxonomy version is not installed");
  const artifact = parseGenreTaxonomyArtifact({
    artifactVersion: version.value,
    taxonomyVersion,
    categories: connection
      .prepare<CategoryRow>(
        "SELECT category_id, label, parent_category_id FROM genre_taxonomy_category WHERE taxonomy_version = ? ORDER BY category_id",
      )
      .all([taxonomyVersion])
      .map((row) => ({ id: row.category_id, label: row.label, parentId: row.parent_category_id })),
    mappings: connection
      .prepare<MappingRow>(
        "SELECT source_tag, mapping_action AS action, target_category_id FROM genre_taxonomy_mapping WHERE taxonomy_version = ? ORDER BY source_tag",
      )
      .all([taxonomyVersion])
      .map((row) => ({
        sourceTag: row.source_tag,
        action: row.action,
        targetCategoryId: row.target_category_id,
      })),
  });
  return canonicalizeGenreTaxonomyArtifact(artifact);
}
