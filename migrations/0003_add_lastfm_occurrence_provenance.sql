CREATE TABLE lastfm_scrobble_occurrence (
  source_record_id INTEGER PRIMARY KEY
    REFERENCES source_record (id) ON DELETE CASCADE,
  lastfm_scrobble_source_record_id INTEGER NOT NULL
    REFERENCES lastfm_scrobble_source (source_record_id),
  source_origin TEXT NOT NULL CHECK (source_origin IN ('export', 'api'))
) STRICT;

CREATE INDEX lastfm_scrobble_occurrence_evidence_idx
  ON lastfm_scrobble_occurrence (lastfm_scrobble_source_record_id);

INSERT INTO lastfm_scrobble_occurrence
  (source_record_id, lastfm_scrobble_source_record_id, source_origin)
SELECT source_record_id, source_record_id, source_origin
FROM lastfm_scrobble_source;
