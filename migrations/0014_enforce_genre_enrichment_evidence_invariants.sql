-- These triggers extend the applied 0012 evidence contract without rewriting its migration.
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

CREATE TRIGGER genre_enrichment_snapshot_delete_is_forbidden
BEFORE DELETE ON genre_enrichment_snapshot
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment snapshots are immutable; create a superseding snapshot');
END;

CREATE TRIGGER genre_enrichment_raw_tag_delete_is_forbidden
BEFORE DELETE ON genre_enrichment_raw_tag
BEGIN
  SELECT RAISE(ABORT, 'Genre enrichment raw tags are immutable evidence');
END;
