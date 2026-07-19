# Database schema

The initial schema is defined by `migrations/0001_create_initial_schema.sql`. P1-01 adds operational
ingest counters through `migrations/0002_add_ingest_lifecycle_counts.sql`. The schema separates
operational metadata, immutable source evidence, music identity, reconciliation, canonical events,
genre enrichment, synchronization cursors, and safe rejection diagnostics. Analytical aggregates
remain queries over these layers; the schema deliberately contains no speculative materialized
analysis tables.

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

`source_record` is the common parent of `spotify_play_source` and `lastfm_scrobble_source`. This
additional structural table lets canonical event links use a real foreign key while the source
tables retain their distinct, approved fields. Exact Spotify duplicates may share a fingerprint
but remain separate source rows. Last.fm fingerprints are unique so export/API overlap reuses the
same evidence row.

External identifiers attach to a `music_entity` parent shared by artists, releases, and tracks.
This likewise avoids an unenforceable polymorphic identifier reference. Display text remains in
the entity and source tables; normalized aliases are separate and versioned.

## Privacy boundary

The schema stores only projected, approved fields. It has no columns for IP addresses, account
names, user-agent strings, Spotify country or platform/device context, secrets or API keys, or raw
rejected payloads. `rejected_source_record.safe_diagnostic_summary` may contain only a sanitized
description and error code. Last.fm cursor scope is a one-way fingerprint rather than account text.
