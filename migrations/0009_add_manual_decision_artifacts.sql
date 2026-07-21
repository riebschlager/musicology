-- P2-09 records portable manual directives separately from automatic policy history. Decision
-- keys come from the reviewed artifact and make re-imports idempotent.
CREATE TABLE manual_decision_artifact (
  decision_key TEXT PRIMARY KEY CHECK (length(decision_key) BETWEEN 1 AND 128),
  artifact_version TEXT NOT NULL CHECK (length(artifact_version) > 0),
  decision_type TEXT NOT NULL CHECK (
    decision_type IN ('merge', 'split', 'alias', 'accept', 'reject')
  ),
  payload_json TEXT NOT NULL CHECK (length(payload_json) > 0),
  imported_at_epoch_ms INTEGER NOT NULL CHECK (imported_at_epoch_ms >= 0)
) STRICT;

CREATE TABLE manual_identity_decision (
  decision_key TEXT PRIMARY KEY REFERENCES manual_decision_artifact (decision_key) ON DELETE CASCADE,
  identity_decision_id INTEGER NOT NULL UNIQUE REFERENCES identity_decision (id),
  subject_source_record_id INTEGER NOT NULL REFERENCES source_record (id),
  object_source_record_id INTEGER REFERENCES source_record (id)
) STRICT;

CREATE TABLE manual_reconciliation_decision (
  decision_key TEXT PRIMARY KEY REFERENCES manual_decision_artifact (decision_key) ON DELETE CASCADE,
  reconciliation_candidate_id INTEGER NOT NULL REFERENCES reconciliation_candidate (id),
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
  source_listening_event_id INTEGER REFERENCES listening_event (id),
  target_listening_event_id INTEGER REFERENCES listening_event (id),
  source_event_status TEXT CHECK (source_event_status IN ('current', 'unresolved')),
  CHECK (
    (decision = 'accept' AND source_listening_event_id IS NOT NULL
      AND target_listening_event_id IS NOT NULL AND source_event_status IS NOT NULL)
    OR decision = 'reject'
  )
) STRICT;

CREATE INDEX manual_reconciliation_decision_candidate_idx
  ON manual_reconciliation_decision (reconciliation_candidate_id);
