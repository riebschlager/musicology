-- Curated taxonomy versions are derived, portable decisions. They never modify immutable provider evidence.
CREATE TABLE genre_taxonomy_version (
  taxonomy_version TEXT PRIMARY KEY CHECK (length(taxonomy_version) > 0),
  artifact_version TEXT NOT NULL CHECK (artifact_version = 'genre-taxonomy-v1'),
  content_fingerprint_sha256 TEXT NOT NULL CHECK (length(content_fingerprint_sha256) = 64),
  imported_at_epoch_ms INTEGER NOT NULL CHECK (imported_at_epoch_ms >= 0)
) STRICT;

CREATE TABLE genre_taxonomy_category (
  taxonomy_version TEXT NOT NULL REFERENCES genre_taxonomy_version (taxonomy_version),
  category_id TEXT NOT NULL CHECK (length(category_id) > 0),
  label TEXT NOT NULL CHECK (length(label) > 0),
  parent_category_id TEXT,
  PRIMARY KEY (taxonomy_version, category_id),
  FOREIGN KEY (taxonomy_version, parent_category_id)
    REFERENCES genre_taxonomy_category (taxonomy_version, category_id),
  CHECK (parent_category_id IS NULL OR parent_category_id <> category_id)
) STRICT;

CREATE TABLE genre_taxonomy_mapping (
  taxonomy_version TEXT NOT NULL REFERENCES genre_taxonomy_version (taxonomy_version),
  source_tag TEXT NOT NULL CHECK (length(source_tag) > 0),
  mapping_action TEXT NOT NULL CHECK (mapping_action IN ('keep', 'combine', 'rename', 'ignore')),
  target_category_id TEXT,
  PRIMARY KEY (taxonomy_version, source_tag),
  FOREIGN KEY (taxonomy_version, target_category_id)
    REFERENCES genre_taxonomy_category (taxonomy_version, category_id),
  CHECK (
    (mapping_action = 'ignore' AND target_category_id IS NULL) OR
    (mapping_action <> 'ignore' AND target_category_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX genre_taxonomy_mapping_target_idx
  ON genre_taxonomy_mapping (taxonomy_version, target_category_id);
