-- P2-06 adds the feature columns that were intentionally deferred from the
-- reconciliation_candidate placeholder. Existing candidate rows, if any, retain NULL
-- because their feature values cannot be reconstructed without their rule implementation.
ALTER TABLE reconciliation_candidate
  ADD COLUMN short_play_score REAL CHECK (short_play_score IS NULL OR short_play_score BETWEEN 0.0 AND 1.0);

ALTER TABLE reconciliation_candidate
  ADD COLUMN competing_candidate_score REAL CHECK (
    competing_candidate_score IS NULL OR competing_candidate_score BETWEEN 0.0 AND 1.0
  );
