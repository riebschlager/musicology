ALTER TABLE ingest_run
  ADD COLUMN discovered_file_count INTEGER NOT NULL DEFAULT 0
    CHECK (discovered_file_count >= 0);

ALTER TABLE ingest_run
  ADD COLUMN registered_file_count INTEGER NOT NULL DEFAULT 0
    CHECK (registered_file_count >= 0);

ALTER TABLE ingest_run
  ADD COLUMN noop_file_count INTEGER NOT NULL DEFAULT 0
    CHECK (noop_file_count >= 0);

ALTER TABLE ingest_run
  ADD COLUMN duplicated_count INTEGER NOT NULL DEFAULT 0
    CHECK (duplicated_count >= 0);

ALTER TABLE ingest_run
  ADD COLUMN excluded_count INTEGER NOT NULL DEFAULT 0
    CHECK (excluded_count >= 0);

CREATE TRIGGER ingest_run_reconcile_counts_before_insert
BEFORE INSERT ON ingest_run
WHEN NEW.status = 'succeeded' AND (
  NEW.discovered_count <> NEW.accepted_count + NEW.excluded_count + NEW.rejected_count OR
  NEW.duplicated_count > NEW.accepted_count OR
  NEW.discovered_file_count <>
    NEW.registered_file_count + NEW.noop_file_count + NEW.unsupported_count
)
BEGIN
  SELECT RAISE(ABORT, 'succeeded ingest_run counts do not reconcile');
END;

CREATE TRIGGER ingest_run_reconcile_counts_before_update
BEFORE UPDATE ON ingest_run
WHEN NEW.status = 'succeeded' AND (
  NEW.discovered_count <> NEW.accepted_count + NEW.excluded_count + NEW.rejected_count OR
  NEW.duplicated_count > NEW.accepted_count OR
  NEW.discovered_file_count <>
    NEW.registered_file_count + NEW.noop_file_count + NEW.unsupported_count
)
BEGIN
  SELECT RAISE(ABORT, 'succeeded ingest_run counts do not reconcile');
END;
