-- API response metadata is deliberately aggregate-only: no URL, account identifier, API key,
-- or response body is retained.
CREATE TABLE lastfm_api_sync_metadata (
  ingest_run_id INTEGER PRIMARY KEY REFERENCES ingest_run (id) ON DELETE CASCADE,
  page_count INTEGER NOT NULL CHECK (page_count >= 0),
  completed_track_count INTEGER NOT NULL CHECK (completed_track_count >= 0),
  ignored_now_playing_count INTEGER NOT NULL CHECK (ignored_now_playing_count >= 0)
) STRICT;

CREATE TRIGGER lastfm_api_sync_metadata_requires_api_run_on_insert
BEFORE INSERT ON lastfm_api_sync_metadata
WHEN (SELECT command_type FROM ingest_run WHERE id = NEW.ingest_run_id) IS NOT 'lastfm_api_sync'
BEGIN
  SELECT RAISE(ABORT, 'Last.fm API sync metadata requires a lastfm_api_sync ingest run');
END;

CREATE TRIGGER lastfm_api_sync_metadata_requires_api_run_on_update
BEFORE UPDATE OF ingest_run_id ON lastfm_api_sync_metadata
WHEN (SELECT command_type FROM ingest_run WHERE id = NEW.ingest_run_id) IS NOT 'lastfm_api_sync'
BEGIN
  SELECT RAISE(ABORT, 'Last.fm API sync metadata requires a lastfm_api_sync ingest run');
END;

CREATE TRIGGER lastfm_api_sync_metadata_preserves_api_run_type
BEFORE UPDATE OF command_type ON ingest_run
WHEN NEW.command_type <> 'lastfm_api_sync'
 AND EXISTS (
   SELECT 1 FROM lastfm_api_sync_metadata WHERE ingest_run_id = OLD.id
 )
BEGIN
  SELECT RAISE(ABORT, 'Last.fm API sync metadata requires a lastfm_api_sync ingest run');
END;
