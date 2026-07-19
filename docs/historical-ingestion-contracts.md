# Historical ingestion contracts

P1-01 establishes a shared boundary for the Spotify and Last.fm historical importers. Source-format
discovery, parsing, classification, and source-specific persistence remain in their later Phase 1
tasks.

## Discovery and file identity

A source-specific discovery adapter must positively classify a candidate as `spotify_export` or
`lastfm_export`; unknown files are unsupported rather than guessed from arbitrary JSON. A discovered
file carries an absolute read path, a normalized repository-relative evidence path using `/`
separators with no absolute, empty, repeated, `.` or `..` segments, and its source type.

The file content hash is lowercase SHA-256 over the exact bytes read from disk. Hashing does not
parse, normalize, or rewrite the file. Registration is unique by both relative path and content
hash. The same path and hash, or the same bytes under another path, is a no-op. Different bytes at a
registered path fail safely as `source_file_changed` and do not modify existing evidence.

## Record fingerprints

A source fingerprint is not a file hash. It is lowercase SHA-256 over a canonical, versioned set of
allowlisted record fields. The canonical encoder sorts field names by stable code-unit order and
preserves scalar types, nulls, exact Unicode display text, and integer values. It is designed to
receive only a projected record, never a raw source object. Each source-specific importer must
document its fingerprint version and approved field set when that importer is implemented.

Changing fingerprint fields or their meaning requires a new fingerprint version. File names,
ordinals, ingest times, and excluded private fields must not enter a record fingerprint.

## Outcomes and count reconciliation

Every parsed record has exactly one primary outcome: accepted, excluded non-music, or rejected.
An exact duplicate source row is accepted evidence and is additionally marked duplicated. Thus:

```text
records.discovered = records.accepted + records.excluded + records.rejected
records.duplicated <= records.accepted

files.discovered = files.registered + files.noOp + files.unsupported
```

SQLite enforces these equations whenever an ingest run is inserted or updated as `succeeded`.
An unchanged registered file can complete as a successful no-op without parsing or adding evidence.
The operational run stores file and record counts separately. The pre-existing `unsupported_count`
stores unsupported file count; `excluded_count` stores supported non-music record count.

Stable issue codes are:

- `unsupported_source_file` for a candidate outside the explicit source contract;
- `malformed_source_file` for a supported file that cannot be safely parsed as a file;
- `rejected_source_record` for a supported record that fails validation;
- `duplicate_source_record` for an accepted evidence row sharing a source fingerprint;
- `excluded_non_music_record` for a supported, valid, non-track record;
- `source_file_changed` for different bytes at a registered evidence path; and
- `ingest_failed` for an unexpected failure whose details are not safe to persist.

Issue codes and their diagnostic summaries are fixed, privacy-reviewed constants. Record outcomes do
not accept caller-supplied diagnostic text, so raw payloads, parser messages, and excluded source
values cannot be forwarded through the shared contract.

## Transaction lifecycle

The lifecycle first creates a `running` audit row. File registration, rejection rows, source evidence,
outcome counting, and the transition to `succeeded` then occur in one immediate transaction. A
failure rolls that transaction back and records only a `failed` audit row with a safe summary.
Unexpected exception messages are replaced rather than persisted because they may contain source
data. A failed attempt cannot leave a completed successful run, a registered file, rejection rows,
or partial evidence from the attempt. If the completion clock is unavailable or invalid while a
failure is being finalized, the already validated run start time is used as the failure completion
time so the audit row does not remain `running`.
