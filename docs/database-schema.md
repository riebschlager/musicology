# Database schema

The initial schema is defined by `migrations/0001_create_initial_schema.sql`. P1-01 adds operational
ingest counters through `migrations/0002_add_ingest_lifecycle_counts.sql`, and P1-05 adds Last.fm
occurrence provenance through `migrations/0003_add_lastfm_occurrence_provenance.sql`.
`migrations/0004_scope_source_file_hash_by_type.sql` scopes file-hash uniqueness to the declared
source type so byte-identical files from different source formats retain independent registrations.
`migrations/0005_add_identity_resolution.sql` adds versioned artist, release, and track aliases plus
one current identity interpretation per source occurrence, including both resolution-rule and
normalization versions. Strong-identifier/composite disagreements are retained as conflict rows;
they never authorize an automatic merge.
The schema separates operational metadata, immutable source evidence, music identity,
reconciliation, canonical events, genre enrichment, synchronization cursors, and safe rejection
diagnostics. Analytical aggregates remain queries over these layers; the schema deliberately
contains no speculative materialized analysis tables.

## Ingest lifecycle counts

`ingest_run` keeps discovered, accepted, duplicated, excluded, and rejected record counts separately
from discovered, newly registered, unchanged/no-op, and unsupported file counts. Duplicate rows are
accepted source evidence, so `duplicated_count` is a subset of `accepted_count`. Excluded non-music
records use `excluded_count`; `unsupported_count` is reserved for unsupported candidate files. The
database rejects a successful run whose record totals, duplicate bound, or file totals do not
reconcile. The shared count and transaction contract is documented in
[`historical-ingestion-contracts.md`](historical-ingestion-contracts.md).

## Canonical timestamp representation

Domain timestamps are non-negative `INTEGER` Unix epoch milliseconds representing UTC instants.
This is the canonical representation for source observations, derived event times, API cursor
boundaries, enrichment fetches, decisions, and ingest operations. It preserves Spotify's
millisecond precision, converts Last.fm seconds without loss, supports indexed SQLite arithmetic
for reconciliation, and serializes without timezone ambiguity. Calendar grouping must convert the
instant using an explicitly named presentation timezone; the configured default is
`America/Chicago`.

The migration runner's `schema_migration.applied_at_utc` remains an ISO 8601 UTC string. It is
pre-existing toolchain audit metadata, not a music-domain timestamp or an analytical input.

Spotify timestamps are observed stop times. A canonical start may later be derived by subtracting
`ms_played`, with `listening_event.time_basis = 'derived_start'`. The original stop time remains in
`spotify_play_source`.

## Enforceable provenance

`source_file` identifies exact bytes within a declared source type. A content hash is unique for a
given source type, so a renamed copy of the same source export is a no-op while byte-identical files
declared as different formats remain separate evidence registrations.

`source_record` is the common parent of `spotify_play_source` and `lastfm_scrobble_source`. This
additional structural table lets canonical event links use a real foreign key while the source
tables retain their distinct, approved fields. Exact Spotify duplicates may share a fingerprint
but remain separate source rows. A complete Last.fm source fingerprint identifies one unique
`lastfm_scrobble_source` payload. Every accepted export occurrence—including an equivalent
fingerprint—has a separate `source_record` linked through `lastfm_scrobble_occurrence`, preserving
its file, ordinal, and origin while avoiding duplicate payload storage. Canonical duplicate
interpretation and export/API overlap remain later work.

External identifiers attach to a `music_entity` parent shared by artists, releases, and tracks.
This likewise avoids an unenforceable polymorphic identifier reference. Display text remains in
the entity and source tables; normalized aliases are separate and versioned.

## Privacy boundary

The schema stores only projected, approved fields. It has no columns for IP addresses, account
names, user-agent strings, Spotify country or platform/device context, secrets or API keys, or raw
rejected payloads. `rejected_source_record.safe_diagnostic_summary` may contain only a sanitized
description and error code. Last.fm cursor scope is a one-way fingerprint rather than account text.
