# Genre taxonomy mapping workflow

P5-05 adds a portable, curated mapping layer over immutable provider tags. It is optional:
core ingestion, reconciliation, and non-genre analytics remain usable when no taxonomy is installed.
The workflow does not assign genres to events; P5-06 owns that weighting step.

## Artifact contract

An artifact is JSON with `artifactVersion: "genre-taxonomy-v1"`, a caller-chosen immutable
`taxonomyVersion`, category hierarchy, and one mapping for each included normalized raw tag.
Categories have an `id`, display `label`, and nullable `parentId`. Mappings use one of four actions:

- `keep`: retain a raw tag as the named analytical category.
- `combine`: combine synonymous or closely related tags in one category.
- `rename`: map a noisy tag to a differently named category.
- `ignore`: intentionally leave a known tag out of analytical categories.

Every action except `ignore` identifies a category. Categories may be parent/child, but mappings
always target one explicit category; later weighted analysis decides how parent rollups behave.
The parser rejects cycles, duplicate category IDs, duplicate/conflicting source-tag mappings,
unknown target categories, and invalid action/target combinations. Import additionally rejects a
source tag absent from the local immutable raw-evidence table. Unknown is therefore never silently
converted into a genre.

## Import and export

Use an explicit artifact path and a migrated database:

```sh
pnpm genre:taxonomy --import path/to/genre-taxonomy.json
pnpm genre:taxonomy --export taxonomy-v1 --output path/to/genre-taxonomy.json
```

Imports and exports report only the taxonomy version and aggregate outcome; they do not print the
artifact or path. Export refuses to overwrite a file. Re-importing identical content for an existing
version is a no-op. Any changed category or mapping content must carry a new `taxonomyVersion`;
the existing version remains available for reproducible later analysis.

Taxonomy versions and mappings are local derived decisions. They are separate from
`genre_enrichment_snapshot` and `genre_enrichment_raw_tag`, which remain append-only provider
evidence. Importing a taxonomy never updates, deletes, or reinterprets a raw tag. Review provider
licensing before committing or publishing an artifact containing provider-derived tag text.
