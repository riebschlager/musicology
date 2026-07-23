-- Genre enrichment is optional evidence. These snapshots deliberately do not attach
-- curated categories or analytical assignments: those are separate P5-05/P5-06 layers.
CREATE TABLE genre_enrichment_snapshot (
  id INTEGER PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artist (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'musicbrainz'),
  provider_entity_id TEXT NOT NULL CHECK (length(provider_entity_id) > 0),
  provider_response_schema_version TEXT NOT NULL CHECK (length(provider_response_schema_version) > 0),
  contract_version TEXT NOT NULL CHECK (length(contract_version) > 0),
  provider_license TEXT NOT NULL CHECK (length(provider_license) > 0),
  provider_attribution TEXT NOT NULL CHECK (length(provider_attribution) > 0),
  fetched_at_epoch_ms INTEGER NOT NULL CHECK (fetched_at_epoch_ms >= 0),
  cache_state TEXT NOT NULL CHECK (cache_state IN ('success', 'negative', 'failure')),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('success', 'no_tags', 'not_found', 'malformed_response', 'temporary_failure')
  ),
  error_code TEXT CHECK (
    error_code IS NULL OR error_code IN (
      'malformed_response', 'not_found', 'rate_limited', 'network_failure', 'timeout', 'retry_exhausted'
    )
  ),
  supersedes_snapshot_id INTEGER REFERENCES genre_enrichment_snapshot (id),
  UNIQUE (artist_id, provider, fetched_at_epoch_ms),
  CHECK (
    (cache_state = 'success' AND outcome = 'success' AND error_code IS NULL) OR
    (cache_state = 'negative' AND outcome IN ('no_tags', 'not_found') AND
      (error_code IS NULL OR error_code = 'not_found')) OR
    (cache_state = 'failure' AND outcome IN ('malformed_response', 'temporary_failure') AND
      error_code IS NOT NULL)
  ),
  CHECK (supersedes_snapshot_id IS NULL OR supersedes_snapshot_id <> id)
) STRICT;

CREATE INDEX genre_enrichment_snapshot_artist_provider_idx
  ON genre_enrichment_snapshot (artist_id, provider, fetched_at_epoch_ms DESC);
CREATE INDEX genre_enrichment_snapshot_lineage_idx
  ON genre_enrichment_snapshot (supersedes_snapshot_id);

CREATE TRIGGER genre_enrichment_snapshot_lineage_matches_artist_and_provider_on_insert
BEFORE INSERT ON genre_enrichment_snapshot
WHEN NEW.supersedes_snapshot_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
     FROM genre_enrichment_snapshot AS prior
    WHERE prior.id = NEW.supersedes_snapshot_id
      AND prior.artist_id = NEW.artist_id
      AND prior.provider = NEW.provider
 )
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment snapshot lineage must retain artist and provider');
END;

CREATE TRIGGER genre_enrichment_snapshot_lineage_matches_artist_and_provider_on_update
BEFORE UPDATE OF artist_id, provider, supersedes_snapshot_id ON genre_enrichment_snapshot
WHEN NEW.supersedes_snapshot_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
     FROM genre_enrichment_snapshot AS prior
    WHERE prior.id = NEW.supersedes_snapshot_id
      AND prior.artist_id = NEW.artist_id
      AND prior.provider = NEW.provider
 )
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment snapshot lineage must retain artist and provider');
END;

CREATE TRIGGER genre_enrichment_snapshot_requires_exact_strong_artist_identifier
BEFORE INSERT ON genre_enrichment_snapshot
WHEN NOT EXISTS (
  SELECT 1
    FROM music_identifier
   WHERE entity_id = NEW.artist_id
     AND namespace = 'musicbrainz_artist_id'
     AND identifier_value = NEW.provider_entity_id
     AND is_strong = 1
)
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment snapshot requires the artist exact strong MusicBrainz ID');
END;

CREATE TRIGGER genre_enrichment_failure_does_not_supersede_success
BEFORE INSERT ON genre_enrichment_snapshot
WHEN NEW.cache_state = 'failure'
 AND NEW.supersedes_snapshot_id IS NOT NULL
 AND EXISTS (
   SELECT 1
     FROM genre_enrichment_snapshot AS prior
    WHERE prior.id = NEW.supersedes_snapshot_id
      AND prior.cache_state = 'success'
 )
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment failure must not supersede a successful snapshot');
END;

CREATE TRIGGER genre_enrichment_snapshot_is_immutable
BEFORE UPDATE ON genre_enrichment_snapshot
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment snapshots are immutable; create a superseding snapshot');
END;

CREATE TRIGGER genre_enrichment_snapshot_delete_is_forbidden
BEFORE DELETE ON genre_enrichment_snapshot
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment snapshots are immutable; create a superseding snapshot');
END;

CREATE TABLE genre_enrichment_raw_tag (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES genre_enrichment_snapshot (id) ON DELETE CASCADE,
  raw_tag_name TEXT NOT NULL CHECK (length(raw_tag_name) > 0),
  normalized_raw_tag TEXT NOT NULL CHECK (length(normalized_raw_tag) > 0),
  raw_weight REAL NOT NULL CHECK (raw_weight >= 0.0),
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0.0 AND 1.0),
  is_recognized_genre INTEGER NOT NULL CHECK (is_recognized_genre IN (0, 1)),
  UNIQUE (snapshot_id, normalized_raw_tag)
) STRICT;

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
