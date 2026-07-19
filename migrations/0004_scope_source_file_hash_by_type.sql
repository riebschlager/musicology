PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE source_record_file_backup (
  source_record_id INTEGER PRIMARY KEY,
  source_file_id INTEGER NOT NULL,
  source_ordinal INTEGER NOT NULL
) STRICT;

INSERT INTO source_record_file_backup
  (source_record_id, source_file_id, source_ordinal)
SELECT id, source_file_id, source_ordinal
FROM source_record
WHERE source_file_id IS NOT NULL;

CREATE TEMP TABLE rejected_source_record_file_backup (
  rejected_source_record_id INTEGER PRIMARY KEY,
  source_file_id INTEGER NOT NULL
) STRICT;

INSERT INTO rejected_source_record_file_backup
  (rejected_source_record_id, source_file_id)
SELECT id, source_file_id
FROM rejected_source_record
WHERE source_file_id IS NOT NULL;

UPDATE source_record
SET source_file_id = NULL,
    source_ordinal = NULL
WHERE source_file_id IS NOT NULL;

UPDATE rejected_source_record
SET source_file_id = NULL
WHERE source_file_id IS NOT NULL;

CREATE TABLE source_file_replacement (
  id INTEGER PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE CHECK (
    length(relative_path) > 0 AND substr(relative_path, 1, 1) <> '/'
  ),
  source_type TEXT NOT NULL CHECK (source_type IN ('spotify_export', 'lastfm_export')),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_start_epoch_ms INTEGER CHECK (observed_start_epoch_ms >= 0),
  observed_end_epoch_ms INTEGER CHECK (observed_end_epoch_ms >= 0),
  first_ingest_run_id INTEGER NOT NULL REFERENCES ingest_run (id),
  last_ingest_run_id INTEGER NOT NULL REFERENCES ingest_run (id),
  UNIQUE (source_type, content_sha256),
  CHECK (
    observed_start_epoch_ms IS NULL OR observed_end_epoch_ms IS NULL OR
    observed_end_epoch_ms >= observed_start_epoch_ms
  )
) STRICT;

INSERT INTO source_file_replacement
  (id, relative_path, source_type, byte_size, content_sha256,
   observed_start_epoch_ms, observed_end_epoch_ms,
   first_ingest_run_id, last_ingest_run_id)
SELECT id, relative_path, source_type, byte_size, content_sha256,
       observed_start_epoch_ms, observed_end_epoch_ms,
       first_ingest_run_id, last_ingest_run_id
FROM source_file;

DROP TABLE source_file;
ALTER TABLE source_file_replacement RENAME TO source_file;

CREATE INDEX source_file_source_type_idx ON source_file (source_type);

UPDATE source_record
SET source_file_id = (
      SELECT backup.source_file_id
      FROM source_record_file_backup AS backup
      WHERE backup.source_record_id = source_record.id
    ),
    source_ordinal = (
      SELECT backup.source_ordinal
      FROM source_record_file_backup AS backup
      WHERE backup.source_record_id = source_record.id
    )
WHERE id IN (SELECT source_record_id FROM source_record_file_backup);

UPDATE rejected_source_record
SET source_file_id = (
      SELECT backup.source_file_id
      FROM rejected_source_record_file_backup AS backup
      WHERE backup.rejected_source_record_id = rejected_source_record.id
    )
WHERE id IN (SELECT rejected_source_record_id FROM rejected_source_record_file_backup);

DROP TABLE source_record_file_backup;
DROP TABLE rejected_source_record_file_backup;
