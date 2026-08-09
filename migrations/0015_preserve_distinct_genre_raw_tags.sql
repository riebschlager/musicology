-- Provider tags can have distinct raw spellings that share one matching normalization.
-- Rebuild only the raw-tag table so every raw spelling remains immutable evidence.
DROP TRIGGER genre_enrichment_raw_tag_requires_success_snapshot;
DROP TRIGGER genre_enrichment_raw_tag_is_immutable;
DROP TRIGGER genre_enrichment_raw_tag_delete_is_forbidden;
DROP INDEX genre_enrichment_raw_tag_snapshot_idx;

ALTER TABLE genre_enrichment_raw_tag RENAME TO genre_enrichment_raw_tag_legacy;

CREATE TABLE genre_enrichment_raw_tag (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES genre_enrichment_snapshot (id) ON DELETE CASCADE,
  raw_tag_name TEXT NOT NULL CHECK (length(raw_tag_name) > 0),
  normalized_raw_tag TEXT NOT NULL CHECK (length(normalized_raw_tag) > 0),
  raw_weight REAL NOT NULL CHECK (raw_weight >= 0.0),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0.0 AND 1.0),
  is_recognized_genre INTEGER NOT NULL CHECK (is_recognized_genre IN (0, 1)),
  UNIQUE (snapshot_id, raw_tag_name)
) STRICT;

INSERT INTO genre_enrichment_raw_tag (
  id, snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre
)
SELECT id, snapshot_id, raw_tag_name, normalized_raw_tag, raw_weight, confidence, is_recognized_genre
  FROM genre_enrichment_raw_tag_legacy;

DROP TABLE genre_enrichment_raw_tag_legacy;

CREATE TRIGGER genre_enrichment_raw_tag_requires_success_snapshot
BEFORE INSERT ON genre_enrichment_raw_tag
WHEN (SELECT cache_state FROM genre_enrichment_snapshot WHERE id = NEW.snapshot_id) <> 'success'
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment raw tags require a successful snapshot');
END;

CREATE TRIGGER genre_enrichment_raw_tag_is_immutable
BEFORE UPDATE ON genre_enrichment_raw_tag
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment raw tags are immutable evidence');
END;

CREATE TRIGGER genre_enrichment_raw_tag_delete_is_forbidden
BEFORE DELETE ON genre_enrichment_raw_tag
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment raw tags are immutable evidence');
END;

CREATE INDEX genre_enrichment_raw_tag_snapshot_idx
  ON genre_enrichment_raw_tag (snapshot_id, is_recognized_genre, raw_weight DESC);
