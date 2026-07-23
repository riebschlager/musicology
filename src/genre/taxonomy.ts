export const GENRE_TAXONOMY_ARTIFACT_VERSION = "genre-taxonomy-v1";

export const genreMappingActions = ["keep", "combine", "rename", "ignore"] as const;
export type GenreMappingAction = (typeof genreMappingActions)[number];

export interface GenreTaxonomyCategory {
  readonly id: string;
  readonly label: string;
  readonly parentId: string | null;
}

export interface GenreTagMapping {
  readonly sourceTag: string;
  readonly action: GenreMappingAction;
  readonly targetCategoryId: string | null;
}

export interface GenreTaxonomyArtifact {
  readonly artifactVersion: typeof GENRE_TAXONOMY_ARTIFACT_VERSION;
  readonly taxonomyVersion: string;
  readonly categories: readonly GenreTaxonomyCategory[];
  readonly mappings: readonly GenreTagMapping[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`Genre taxonomy ${field} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredText(value, field);
}

function compareUnicodeCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseCategory(value: unknown): GenreTaxonomyCategory {
  if (!isRecord(value)) throw new TypeError("Genre taxonomy category must be an object");
  return {
    id: requiredText(value.id, "category ID"),
    label: requiredText(value.label, "category label"),
    parentId: optionalText(value.parentId, "category parent ID"),
  };
}

function parseMapping(value: unknown): GenreTagMapping {
  if (!isRecord(value)) throw new TypeError("Genre taxonomy mapping must be an object");
  const action = value.action;
  if (typeof action !== "string" || !genreMappingActions.includes(action as GenreMappingAction)) {
    throw new TypeError("Genre taxonomy mapping action is invalid");
  }
  const targetCategoryId = optionalText(value.targetCategoryId, "mapping target category ID");
  if ((action === "ignore") !== (targetCategoryId === null)) {
    throw new TypeError(
      "Ignored mappings must not target a category; other mappings must target one",
    );
  }
  return {
    sourceTag: requiredText(value.sourceTag, "mapping source tag"),
    action: action as GenreMappingAction,
    targetCategoryId,
  };
}

function validateCategoryGraph(categories: readonly GenreTaxonomyCategory[]): void {
  const byId = new Map(categories.map((category) => [category.id, category]));
  if (byId.size !== categories.length)
    throw new TypeError("Genre taxonomy contains duplicate category IDs");
  for (const category of categories) {
    if (category.parentId !== null && !byId.has(category.parentId)) {
      throw new TypeError("Genre taxonomy category references an unknown parent");
    }
    const ancestors = new Set<string>();
    let current: GenreTaxonomyCategory = category;
    while (current.parentId !== null) {
      if (ancestors.has(current.id))
        throw new TypeError("Genre taxonomy category hierarchy contains a cycle");
      ancestors.add(current.id);
      const parent = byId.get(current.parentId);
      if (parent === undefined)
        throw new TypeError("Genre taxonomy category references an unknown parent");
      current = parent;
    }
  }
}

/** Parses the portable curated mapping artifact before it can affect local derived state. */
export function parseGenreTaxonomyArtifact(value: unknown): GenreTaxonomyArtifact {
  if (!isRecord(value) || value.artifactVersion !== GENRE_TAXONOMY_ARTIFACT_VERSION) {
    throw new TypeError("Genre taxonomy artifact format is invalid");
  }
  if (!Array.isArray(value.categories) || !Array.isArray(value.mappings)) {
    throw new TypeError("Genre taxonomy artifact must contain categories and mappings arrays");
  }
  const categories = value.categories.map(parseCategory);
  const mappings = value.mappings.map(parseMapping);
  validateCategoryGraph(categories);
  const categoryIds = new Set(categories.map((category) => category.id));
  const sourceTags = new Set<string>();
  for (const mapping of mappings) {
    if (sourceTags.has(mapping.sourceTag))
      throw new TypeError("Genre taxonomy contains duplicate mappings for one source tag");
    sourceTags.add(mapping.sourceTag);
    if (mapping.targetCategoryId !== null && !categoryIds.has(mapping.targetCategoryId)) {
      throw new TypeError("Genre taxonomy mapping references an unknown category");
    }
  }
  return {
    artifactVersion: GENRE_TAXONOMY_ARTIFACT_VERSION,
    taxonomyVersion: requiredText(value.taxonomyVersion, "version"),
    categories,
    mappings,
  };
}

/** Produces a deterministic representation suitable for equality checks and portable export. */
export function canonicalizeGenreTaxonomyArtifact(
  artifact: GenreTaxonomyArtifact,
): GenreTaxonomyArtifact {
  return {
    ...artifact,
    categories: [...artifact.categories].sort((left, right) =>
      compareUnicodeCodeUnits(left.id, right.id),
    ),
    mappings: [...artifact.mappings].sort((left, right) =>
      compareUnicodeCodeUnits(left.sourceTag, right.sourceTag),
    ),
  };
}
