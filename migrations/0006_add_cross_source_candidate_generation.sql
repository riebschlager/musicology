-- P2-05 keeps candidate generation distinct from the scored reconciliation candidates that
-- P2-06 will create. A generated pair records only the bounded-entry rationale and rule.
CREATE TABLE cross_source_candidate_generation (
  id INTEGER PRIMARY KEY,
  spotify_source_record_id INTEGER NOT NULL
    REFERENCES spotify_play_source (source_record_id),
  lastfm_source_record_id INTEGER NOT NULL
    REFERENCES lastfm_scrobble_source (source_record_id),
  candidate_reason TEXT NOT NULL CHECK (
    candidate_reason IN ('shared_track_identity', 'matching_normalized_artist_track')
  ),
  generation_rule_version TEXT NOT NULL,
  generated_at_epoch_ms INTEGER NOT NULL CHECK (generated_at_epoch_ms >= 0),
  UNIQUE (spotify_source_record_id, lastfm_source_record_id, generation_rule_version)
) STRICT;

CREATE INDEX cross_source_candidate_generation_rule_idx
  ON cross_source_candidate_generation (generation_rule_version, candidate_reason);

-- Fixed one-minute blocks let the bounded candidate query seek the other source without a
-- Cartesian source-pair scan. The actual acceptance window remains configurable in code.
CREATE INDEX spotify_play_source_derived_start_block_idx
  ON spotify_play_source (((stopped_at_epoch_ms - ms_played) / 60000));
CREATE INDEX lastfm_scrobble_source_time_block_idx
  ON lastfm_scrobble_source ((scrobbled_at_epoch_ms / 60000));
