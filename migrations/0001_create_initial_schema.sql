CREATE TABLE ingest_run (
  id INTEGER PRIMARY KEY,
  command_type TEXT NOT NULL CHECK (
    command_type IN (
      'spotify_import',
      'lastfm_export_import',
      'lastfm_api_sync',
      'identity_resolution',
      'reconciliation',
      'genre_enrichment'
    )
  ),
  started_at_epoch_ms INTEGER NOT NULL CHECK (started_at_epoch_ms >= 0),
  completed_at_epoch_ms INTEGER CHECK (
    completed_at_epoch_ms IS NULL OR completed_at_epoch_ms >= started_at_epoch_ms
  ),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  schema_version TEXT NOT NULL,
  rule_version TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  unsupported_count INTEGER NOT NULL DEFAULT 0 CHECK (unsupported_count >= 0),
  safe_error_summary TEXT,
  CHECK (
    (status = 'running' AND completed_at_epoch_ms IS NULL) OR
    (status IN ('succeeded', 'failed') AND completed_at_epoch_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX ingest_run_status_started_idx
  ON ingest_run (status, started_at_epoch_ms);

CREATE TABLE source_file (
  id INTEGER PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE CHECK (
    length(relative_path) > 0 AND substr(relative_path, 1, 1) <> '/'
  ),
  source_type TEXT NOT NULL CHECK (source_type IN ('spotify_export', 'lastfm_export')),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_start_epoch_ms INTEGER CHECK (observed_start_epoch_ms >= 0),
  observed_end_epoch_ms INTEGER CHECK (observed_end_epoch_ms >= 0),
  first_ingest_run_id INTEGER NOT NULL REFERENCES ingest_run (id),
  last_ingest_run_id INTEGER NOT NULL REFERENCES ingest_run (id),
  CHECK (
    observed_start_epoch_ms IS NULL OR observed_end_epoch_ms IS NULL OR
    observed_end_epoch_ms >= observed_start_epoch_ms
  )
) STRICT;

CREATE INDEX source_file_source_type_idx ON source_file (source_type);

-- Parent row for source-specific evidence. It makes provenance links enforceable without a
-- polymorphic foreign key. Source-specific tables share this row's id as their primary key.
CREATE TABLE source_record (
  id INTEGER PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('spotify', 'lastfm')),
  ingest_run_id INTEGER NOT NULL REFERENCES ingest_run (id),
  source_file_id INTEGER REFERENCES source_file (id),
  source_ordinal INTEGER CHECK (source_ordinal IS NULL OR source_ordinal >= 0),
  accepted_at_epoch_ms INTEGER NOT NULL CHECK (accepted_at_epoch_ms >= 0),
  UNIQUE (source_file_id, source_ordinal),
  CHECK (
    (source_file_id IS NULL AND source_ordinal IS NULL) OR
    (source_file_id IS NOT NULL AND source_ordinal IS NOT NULL)
  )
) STRICT;

CREATE INDEX source_record_ingest_run_idx ON source_record (ingest_run_id);
CREATE INDEX source_record_source_file_idx ON source_record (source_file_id, source_ordinal);

CREATE TABLE spotify_play_source (
  source_record_id INTEGER PRIMARY KEY REFERENCES source_record (id) ON DELETE CASCADE,
  stopped_at_epoch_ms INTEGER NOT NULL CHECK (stopped_at_epoch_ms >= 0),
  ms_played INTEGER NOT NULL CHECK (ms_played >= 0),
  spotify_track_uri TEXT NOT NULL CHECK (length(spotify_track_uri) > 0),
  artist_name TEXT NOT NULL CHECK (length(artist_name) > 0),
  album_name TEXT,
  track_name TEXT NOT NULL CHECK (length(track_name) > 0),
  reason_start TEXT,
  reason_end TEXT,
  shuffle INTEGER NOT NULL CHECK (shuffle IN (0, 1)),
  skipped INTEGER CHECK (skipped IS NULL OR skipped IN (0, 1)),
  offline INTEGER CHECK (offline IS NULL OR offline IN (0, 1)),
  offline_at_epoch_ms INTEGER CHECK (offline_at_epoch_ms IS NULL OR offline_at_epoch_ms >= 0),
  source_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(source_fingerprint_sha256) = 64 AND
    source_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

CREATE INDEX spotify_play_source_fingerprint_idx
  ON spotify_play_source (source_fingerprint_sha256);
CREATE INDEX spotify_play_source_track_time_idx
  ON spotify_play_source (spotify_track_uri, stopped_at_epoch_ms);
CREATE INDEX spotify_play_source_time_idx ON spotify_play_source (stopped_at_epoch_ms);

CREATE TABLE lastfm_scrobble_source (
  source_record_id INTEGER PRIMARY KEY REFERENCES source_record (id) ON DELETE CASCADE,
  source_origin TEXT NOT NULL CHECK (source_origin IN ('export', 'api')),
  api_scrobble_id TEXT,
  scrobbled_at_epoch_ms INTEGER NOT NULL CHECK (scrobbled_at_epoch_ms >= 0),
  artist_name TEXT NOT NULL CHECK (length(artist_name) > 0),
  album_name TEXT,
  track_name TEXT NOT NULL CHECK (length(track_name) > 0),
  artist_musicbrainz_id TEXT,
  release_musicbrainz_id TEXT,
  recording_musicbrainz_id TEXT,
  loved INTEGER CHECK (loved IS NULL OR loved IN (0, 1)),
  source_fingerprint_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(source_fingerprint_sha256) = 64 AND
    source_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (source_origin = 'api' OR api_scrobble_id IS NULL)
) STRICT;

CREATE UNIQUE INDEX lastfm_scrobble_source_api_id_idx
  ON lastfm_scrobble_source (api_scrobble_id)
  WHERE api_scrobble_id IS NOT NULL;
CREATE INDEX lastfm_scrobble_source_artist_track_time_idx
  ON lastfm_scrobble_source (artist_name, track_name, scrobbled_at_epoch_ms);
CREATE INDEX lastfm_scrobble_source_time_idx
  ON lastfm_scrobble_source (scrobbled_at_epoch_ms);

CREATE TABLE rejected_source_record (
  id INTEGER PRIMARY KEY,
  ingest_run_id INTEGER NOT NULL REFERENCES ingest_run (id),
  source_file_id INTEGER REFERENCES source_file (id),
  source_ordinal INTEGER CHECK (source_ordinal IS NULL OR source_ordinal >= 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('spotify', 'lastfm')),
  error_code TEXT NOT NULL CHECK (length(error_code) > 0),
  safe_diagnostic_summary TEXT NOT NULL CHECK (length(safe_diagnostic_summary) > 0),
  rejected_at_epoch_ms INTEGER NOT NULL CHECK (rejected_at_epoch_ms >= 0),
  UNIQUE (ingest_run_id, source_file_id, source_ordinal, error_code)
) STRICT;

CREATE INDEX rejected_source_record_run_idx
  ON rejected_source_record (ingest_run_id, error_code);

CREATE TABLE music_entity (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('artist', 'release', 'track')),
  created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0)
) STRICT;

CREATE TABLE artist (
  id INTEGER PRIMARY KEY REFERENCES music_entity (id) ON DELETE CASCADE,
  preferred_name TEXT NOT NULL CHECK (length(preferred_name) > 0)
) STRICT;

CREATE INDEX artist_preferred_name_idx ON artist (preferred_name);

CREATE TABLE release (
  id INTEGER PRIMARY KEY REFERENCES music_entity (id) ON DELETE CASCADE,
  preferred_title TEXT NOT NULL CHECK (length(preferred_title) > 0),
  release_type TEXT NOT NULL CHECK (
    release_type IN ('album', 'single', 'compilation', 'unknown')
  )
) STRICT;

CREATE INDEX release_preferred_title_idx ON release (preferred_title);

CREATE TABLE track (
  id INTEGER PRIMARY KEY REFERENCES music_entity (id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES artist (id),
  preferred_title TEXT NOT NULL CHECK (length(preferred_title) > 0),
  release_id INTEGER REFERENCES release (id)
) STRICT;

CREATE INDEX track_artist_title_idx ON track (artist_id, preferred_title);
CREATE INDEX track_release_idx ON track (release_id);

CREATE TABLE identity_decision (
  id INTEGER PRIMARY KEY,
  decision_type TEXT NOT NULL CHECK (decision_type IN ('merge', 'split', 'alias')),
  subject_entity_id INTEGER NOT NULL REFERENCES music_entity (id),
  object_entity_id INTEGER REFERENCES music_entity (id),
  alias_text TEXT,
  decided_at_epoch_ms INTEGER NOT NULL CHECK (decided_at_epoch_ms >= 0),
  decision_version TEXT NOT NULL,
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  supersedes_decision_id INTEGER REFERENCES identity_decision (id),
  CHECK (object_entity_id IS NULL OR object_entity_id <> subject_entity_id),
  CHECK (
    (decision_type IN ('merge', 'split') AND object_entity_id IS NOT NULL AND alias_text IS NULL) OR
    (decision_type = 'alias' AND object_entity_id IS NULL AND alias_text IS NOT NULL)
  )
) STRICT;

CREATE INDEX identity_decision_subject_idx
  ON identity_decision (subject_entity_id, decision_type);

CREATE TABLE artist_alias (
  id INTEGER PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artist (id) ON DELETE CASCADE,
  display_alias TEXT NOT NULL CHECK (length(display_alias) > 0),
  normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) > 0),
  normalization_version TEXT NOT NULL,
  alias_source TEXT NOT NULL CHECK (alias_source IN ('source', 'manual')),
  source_record_id INTEGER REFERENCES source_record (id),
  identity_decision_id INTEGER REFERENCES identity_decision (id),
  CHECK (
    (alias_source = 'source' AND source_record_id IS NOT NULL) OR
    (alias_source = 'manual' AND identity_decision_id IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX artist_alias_identity_idx
  ON artist_alias (artist_id, normalized_alias, normalization_version);
CREATE INDEX artist_alias_normalized_idx
  ON artist_alias (normalized_alias, normalization_version);

CREATE TABLE music_identifier (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES music_entity (id) ON DELETE CASCADE,
  namespace TEXT NOT NULL CHECK (
    namespace IN (
      'spotify_artist_uri',
      'spotify_release_uri',
      'spotify_track_uri',
      'musicbrainz_artist_id',
      'musicbrainz_release_id',
      'musicbrainz_recording_id'
    )
  ),
  identifier_value TEXT NOT NULL CHECK (length(identifier_value) > 0),
  is_strong INTEGER NOT NULL CHECK (is_strong IN (0, 1)),
  source_record_id INTEGER REFERENCES source_record (id),
  UNIQUE (namespace, identifier_value)
) STRICT;

CREATE INDEX music_identifier_entity_idx ON music_identifier (entity_id);

CREATE TABLE listening_event (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES track (id),
  started_at_epoch_ms INTEGER,
  ended_at_epoch_ms INTEGER,
  listened_ms INTEGER CHECK (listened_ms IS NULL OR listened_ms >= 0),
  time_basis TEXT NOT NULL CHECK (
    time_basis IN ('observed_start', 'observed_end', 'derived_start')
  ),
  event_status TEXT NOT NULL CHECK (event_status IN ('current', 'unresolved', 'superseded')),
  reconciliation_rule_version TEXT NOT NULL,
  superseded_by_event_id INTEGER REFERENCES listening_event (id),
  CHECK (started_at_epoch_ms IS NULL OR started_at_epoch_ms >= 0),
  CHECK (ended_at_epoch_ms IS NULL OR ended_at_epoch_ms >= 0),
  CHECK (started_at_epoch_ms IS NOT NULL OR ended_at_epoch_ms IS NOT NULL),
  CHECK (
    started_at_epoch_ms IS NULL OR ended_at_epoch_ms IS NULL OR
    ended_at_epoch_ms >= started_at_epoch_ms
  ),
  CHECK (
    (event_status = 'superseded' AND superseded_by_event_id IS NOT NULL) OR
    (event_status <> 'superseded' AND superseded_by_event_id IS NULL)
  ),
  CHECK (superseded_by_event_id IS NULL OR superseded_by_event_id <> id)
) STRICT;

CREATE INDEX listening_event_track_time_idx
  ON listening_event (track_id, started_at_epoch_ms);
CREATE INDEX listening_event_status_time_idx
  ON listening_event (event_status, started_at_epoch_ms);

CREATE TABLE reconciliation_candidate (
  id INTEGER PRIMARY KEY,
  spotify_source_record_id INTEGER NOT NULL
    REFERENCES spotify_play_source (source_record_id),
  lastfm_source_record_id INTEGER NOT NULL
    REFERENCES lastfm_scrobble_source (source_record_id),
  identifier_agreement INTEGER CHECK (identifier_agreement IS NULL OR identifier_agreement IN (0, 1)),
  artist_score REAL NOT NULL CHECK (artist_score BETWEEN 0.0 AND 1.0),
  track_score REAL NOT NULL CHECK (track_score BETWEEN 0.0 AND 1.0),
  album_score REAL CHECK (album_score IS NULL OR album_score BETWEEN 0.0 AND 1.0),
  start_delta_ms INTEGER NOT NULL,
  duration_score REAL CHECK (duration_score IS NULL OR duration_score BETWEEN 0.0 AND 1.0),
  ordering_score REAL CHECK (ordering_score IS NULL OR ordering_score BETWEEN 0.0 AND 1.0),
  ambiguity_score REAL NOT NULL CHECK (ambiguity_score BETWEEN 0.0 AND 1.0),
  total_confidence REAL NOT NULL CHECK (total_confidence BETWEEN 0.0 AND 1.0),
  rule_version TEXT NOT NULL,
  candidate_state TEXT NOT NULL CHECK (
    candidate_state IN ('pending', 'auto_accepted', 'auto_rejected', 'manually_accepted', 'manually_rejected', 'superseded')
  ),
  resolved_at_epoch_ms INTEGER CHECK (resolved_at_epoch_ms IS NULL OR resolved_at_epoch_ms >= 0),
  resolution_rationale TEXT,
  supersedes_candidate_id INTEGER REFERENCES reconciliation_candidate (id),
  UNIQUE (spotify_source_record_id, lastfm_source_record_id, rule_version),
  CHECK (
    (candidate_state = 'pending' AND resolved_at_epoch_ms IS NULL) OR
    (candidate_state <> 'pending' AND resolved_at_epoch_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX reconciliation_candidate_state_idx
  ON reconciliation_candidate (candidate_state, total_confidence);
CREATE INDEX reconciliation_candidate_lastfm_idx
  ON reconciliation_candidate (lastfm_source_record_id, rule_version);

CREATE TABLE listening_event_source (
  listening_event_id INTEGER NOT NULL REFERENCES listening_event (id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL REFERENCES source_record (id),
  evidence_role TEXT NOT NULL CHECK (
    evidence_role IN ('primary', 'exact_duplicate', 'cross_source_match', 'manual')
  ),
  accepted_match_score REAL CHECK (accepted_match_score IS NULL OR accepted_match_score BETWEEN 0.0 AND 1.0),
  reconciliation_candidate_id INTEGER REFERENCES reconciliation_candidate (id),
  PRIMARY KEY (listening_event_id, source_record_id),
  UNIQUE (source_record_id),
  CHECK (
    (evidence_role = 'cross_source_match' AND reconciliation_candidate_id IS NOT NULL) OR
    evidence_role <> 'cross_source_match'
  )
) STRICT;

CREATE INDEX listening_event_source_event_idx
  ON listening_event_source (listening_event_id, evidence_role);

CREATE TABLE genre_tag (
  id INTEGER PRIMARY KEY,
  tag_name TEXT NOT NULL CHECK (length(tag_name) > 0),
  normalized_tag TEXT NOT NULL CHECK (length(normalized_tag) > 0),
  tag_kind TEXT NOT NULL CHECK (tag_kind IN ('raw', 'curated')),
  UNIQUE (normalized_tag, tag_kind)
) STRICT;

CREATE TABLE artist_genre_evidence (
  id INTEGER PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artist (id) ON DELETE CASCADE,
  genre_tag_id INTEGER NOT NULL REFERENCES genre_tag (id),
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  fetched_at_epoch_ms INTEGER NOT NULL CHECK (fetched_at_epoch_ms >= 0),
  raw_weight REAL NOT NULL CHECK (raw_weight >= 0.0),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  provider_rule_version TEXT NOT NULL,
  UNIQUE (artist_id, genre_tag_id, provider, fetched_at_epoch_ms)
) STRICT;

CREATE INDEX artist_genre_evidence_artist_idx
  ON artist_genre_evidence (artist_id, provider, fetched_at_epoch_ms);

CREATE TABLE genre_mapping (
  id INTEGER PRIMARY KEY,
  source_genre_tag_id INTEGER NOT NULL REFERENCES genre_tag (id),
  curated_genre_tag_id INTEGER NOT NULL REFERENCES genre_tag (id),
  mapping_version TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  UNIQUE (source_genre_tag_id, curated_genre_tag_id, mapping_version),
  CHECK (source_genre_tag_id <> curated_genre_tag_id)
) STRICT;

CREATE INDEX genre_mapping_source_idx
  ON genre_mapping (source_genre_tag_id, mapping_version);

CREATE TABLE sync_cursor (
  id INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type = 'lastfm_api'),
  scope_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(scope_fingerprint_sha256) = 64 AND
    scope_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  boundary_epoch_ms INTEGER NOT NULL CHECK (boundary_epoch_ms >= 0),
  updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= boundary_epoch_ms),
  last_successful_ingest_run_id INTEGER NOT NULL REFERENCES ingest_run (id),
  UNIQUE (source_type, scope_fingerprint_sha256)
) STRICT;
