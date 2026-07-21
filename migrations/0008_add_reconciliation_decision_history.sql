-- P2-08 keeps policy applications separate from scored candidates so a later policy can
-- supersede an automatic decision without overwriting its feature snapshot or audit history.
CREATE TABLE reconciliation_decision (
  id INTEGER PRIMARY KEY,
  reconciliation_candidate_id INTEGER NOT NULL REFERENCES reconciliation_candidate (id),
  policy_rule_version TEXT NOT NULL CHECK (length(policy_rule_version) > 0),
  decision TEXT NOT NULL CHECK (decision IN ('auto_accept', 'review', 'ignore')),
  applied_at_epoch_ms INTEGER NOT NULL CHECK (applied_at_epoch_ms >= 0),
  decision_state TEXT NOT NULL CHECK (decision_state IN ('active', 'superseded')),
  source_listening_event_id INTEGER REFERENCES listening_event (id),
  target_listening_event_id INTEGER REFERENCES listening_event (id),
  source_event_status TEXT CHECK (source_event_status IN ('current', 'unresolved')),
  superseded_by_decision_id INTEGER REFERENCES reconciliation_decision (id),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  UNIQUE (reconciliation_candidate_id, policy_rule_version),
  CHECK (
    (decision = 'auto_accept' AND source_listening_event_id IS NOT NULL
      AND target_listening_event_id IS NOT NULL AND source_event_status IS NOT NULL)
    OR
    (decision <> 'auto_accept' AND source_listening_event_id IS NULL
      AND target_listening_event_id IS NULL AND source_event_status IS NULL)
  ),
  CHECK (superseded_by_decision_id IS NULL OR superseded_by_decision_id <> id)
) STRICT;

CREATE INDEX reconciliation_decision_active_candidate_idx
  ON reconciliation_decision (reconciliation_candidate_id, decision_state);
