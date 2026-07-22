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
`migrations/0006_add_cross_source_candidate_generation.sql` adds the unscored, bounded P2-05
candidate-generation layer and expression indexes for one-minute Spotify derived-start and Last.fm
scrobble-time blocks. It deliberately remains separate from `reconciliation_candidate`, whose
P2-06 feature and score fields are populated by the versioned feature pass.
`migrations/0007_add_reconciliation_match_features.sql` adds nullable short-play and
competing-candidate clarity fields. NULL preserves the fact that any pre-feature candidate row has
no reconstructable value rather than fabricating a default.
`migrations/0008_add_reconciliation_decision_history.sql` adds a policy-application audit layer.
It preserves each scored candidate feature snapshot while recording the active or superseded
automatic, review, and ignore outcome. Automatic decisions retain source and target event IDs and
the prior source-event status so a later policy can reverse and supersede a merge transactionally.
`migrations/0011_add_lastfm_api_sync_metadata.sql` adds one aggregate-only response-metadata row
per Last.fm API sync run: page count, completed-track count, and ignored now-playing count. Its
foreign key and triggers permit only `lastfm_api_sync` runs to own that metadata (including a
running run inside the persistence transaction); changing that run to another command type is also
rejected. The table deliberately stores no account identifier, URL, API key, or response body.
The schema separates operational metadata, immutable source evidence, music identity,
reconciliation, canonical events, genre enrichment, synchronization cursors, and safe rejection
diagnostics. Analytical aggregates remain queries over these layers; the schema deliberately
contains no speculative materialized analysis tables.

`sync_cursor` stores the last wholly successful Last.fm API boundary per one-way account-scope
fingerprint. It references the successful ingest run that established the boundary; P3-04's
planning boundary enforces monotonic updates so bounded recovery work cannot regress normal sync
state.

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

Initial canonical events use `canonical-event-v1` in `reconciliation_rule_version` before any
cross-source reconciliation policy exists. A source whose identity interpretation is explicitly
unresolved receives an event with `event_status = 'unresolved'`; all others are initially `current`.

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
its file, ordinal, and origin while avoiding duplicate payload storage. P2-04 maps each such exact
duplicate group to one current event and retains every source link; redundant initial events are
marked superseded rather than deleted. Cross-source reconciliation remains later work.

External identifiers attach to a `music_entity` parent shared by artists, releases, and tracks.
This likewise avoids an unenforceable polymorphic identifier reference. Display text remains in
the entity and source tables; normalized aliases are separate and versioned.

## Privacy boundary

The schema stores only projected, approved fields. It has no columns for IP addresses, account
names, user-agent strings, Spotify country or platform/device context, secrets or API keys, or raw
rejected payloads. `rejected_source_record.safe_diagnostic_summary` may contain only a sanitized
description and error code. Last.fm cursor scope is a one-way fingerprint rather than account text;
API sync metadata retains only aggregate response counts.
