-- P2-09 makes directed manual identity merges reversible without mutating source evidence or
-- identifier ownership. Split directives restore these snapshots for their matching active merge.
CREATE TABLE manual_identity_resolution_override (
  manual_decision_key TEXT NOT NULL REFERENCES manual_decision_artifact (decision_key) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL REFERENCES source_record (id),
  artist_id INTEGER NOT NULL REFERENCES artist (id),
  release_id INTEGER REFERENCES release (id),
  track_id INTEGER NOT NULL REFERENCES track (id),
  resolution_kind TEXT NOT NULL,
  resolution_rule_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  resolved_at_epoch_ms INTEGER NOT NULL CHECK (resolved_at_epoch_ms >= 0),
  PRIMARY KEY (manual_decision_key, source_record_id)
) STRICT;

CREATE TABLE manual_identity_track_override (
  manual_decision_key TEXT NOT NULL REFERENCES manual_decision_artifact (decision_key) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES track (id),
  artist_id INTEGER REFERENCES artist (id),
  release_id INTEGER REFERENCES release (id),
  PRIMARY KEY (manual_decision_key, track_id),
  CHECK (artist_id IS NOT NULL OR release_id IS NOT NULL)
) STRICT;

CREATE INDEX manual_identity_resolution_override_source_idx
  ON manual_identity_resolution_override (source_record_id);
