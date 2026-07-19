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

## Spotify audio boundary (P1-02)

Spotify discovery accepts only explicit regular files inside the configured evidence root whose
case-sensitive basenames match either
`Streaming_History_Audio_<year>_<part>.json` or
`Streaming_History_Audio_<start-year>-<end-year>_<part>.json`. Candidate directories, symlinks,
video-history files, arbitrary JSON files, and paths outside the evidence root are not discovered.
Filesystem-resolved candidates must also remain inside the filesystem-resolved evidence root, so a
symlinked parent directory cannot bypass the evidence boundary. Discovery is deduplicated and sorted
by normalized evidence-relative path. It does not recursively scan directories or infer a source
from JSON content; callers provide candidate file paths.

A supported file must contain one top-level JSON array. Each array member receives its zero-based
source ordinal and exactly one boundary classification:

- `track` when it has a valid Spotify track URI and the required track projection;
- `excluded` / `episode_or_audiobook` when track identity is absent and supported podcast or
  audiobook markers are present;
- `excluded` / `video_or_unsupported` when track identity and supported non-music markers are both
  absent; or
- `malformed` with a stable safe reason when the record shape, field types, timestamp, duration,
  URI, or required track display text is invalid.

Missing optional evidence fields become `null`; approved display strings are otherwise preserved
exactly, including Unicode and punctuation. A Spotify track URI must contain the `spotify:track:`
prefix followed by exactly 22 ASCII alphanumeric identifier characters. Zero-duration and short
tracks remain valid evidence.
The `ts` field must be an explicit UTC ISO 8601 instant with second or millisecond precision and is
converted to non-negative Unix epoch milliseconds. It is the observed stop time. The boundary also
derives a start instant by exact integer subtraction of `ms_played`; invalid, negative, or unsafe
arithmetic rejects the record.

The track projection allowlist is: observed stop epoch milliseconds, derived start epoch
milliseconds, milliseconds played, Spotify track URI, artist/album/track display text, playback
start and end reasons, shuffle, skipped, offline, and the source `offline_timestamp` numeric value.
File identity, record fingerprints, database persistence, duplicate grouping, and the importer CLI
remain P1-03 work.

Unknown source keys never enter the projection. In particular, the boundary does not return account
names, IP addresses, user-agent strings, country, platform/device context, private-session state, or
raw rejected payloads. File errors use the fixed `malformed_source_file` summary, while record
rejections expose only `rejected_source_record` plus a stable reason code; parser messages and source
values are not included.
