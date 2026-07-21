CREATE TABLE release_alias (
  id INTEGER PRIMARY KEY,
  release_id INTEGER NOT NULL REFERENCES release (id) ON DELETE CASCADE,
  display_alias TEXT NOT NULL CHECK (length(display_alias) > 0),
  normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) > 0),
  normalization_version TEXT NOT NULL,
  source_record_id INTEGER NOT NULL REFERENCES source_record (id),
  UNIQUE (release_id, normalized_alias, normalization_version)
) STRICT;

CREATE INDEX release_alias_normalized_idx
  ON release_alias (normalized_alias, normalization_version);

CREATE TABLE track_alias (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES track (id) ON DELETE CASCADE,
  display_alias TEXT NOT NULL CHECK (length(display_alias) > 0),
  normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) > 0),
  normalization_version TEXT NOT NULL,
  source_record_id INTEGER NOT NULL REFERENCES source_record (id),
  UNIQUE (track_id, normalized_alias, normalization_version)
) STRICT;

CREATE INDEX track_alias_normalized_idx
  ON track_alias (normalized_alias, normalization_version);

CREATE TABLE source_identity_resolution (
  source_record_id INTEGER PRIMARY KEY REFERENCES source_record (id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES artist (id),
  release_id INTEGER REFERENCES release (id),
  track_id INTEGER NOT NULL REFERENCES track (id),
  resolution_kind TEXT NOT NULL CHECK (
    resolution_kind IN ('manual_decision', 'trusted_identifier', 'known_alias',
                        'conservative_composite', 'new_unresolved')
  ),
  resolution_rule_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  resolved_at_epoch_ms INTEGER NOT NULL CHECK (resolved_at_epoch_ms >= 0)
) STRICT;

CREATE INDEX source_identity_resolution_track_idx ON source_identity_resolution (track_id);

CREATE TABLE identity_resolution_conflict (
  id INTEGER PRIMARY KEY,
  source_record_id INTEGER NOT NULL REFERENCES source_record (id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('artist', 'release', 'track')),
  strong_entity_id INTEGER NOT NULL REFERENCES music_entity (id),
  conflicting_entity_id INTEGER NOT NULL REFERENCES music_entity (id),
  normalization_version TEXT NOT NULL,
  CHECK (strong_entity_id <> conflicting_entity_id),
  UNIQUE (source_record_id, entity_type, strong_entity_id, conflicting_entity_id)
) STRICT;
