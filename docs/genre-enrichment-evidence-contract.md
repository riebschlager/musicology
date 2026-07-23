# Genre enrichment evidence contract

P5-02 defines `genre-evidence-v1`, the optional evidence boundary used by the P5-03 MusicBrainz
adapter and later persistence work. It does not add an enrichment command, call a provider, map a
tag to a taxonomy, or assign a genre to an event. Core ingestion and all non-genre analyses remain
usable when the two contract tables contain no rows.

## Snapshot contract

Each `genre_enrichment_snapshot` is an immutable, normalized record of one attempted provider
lookup for one canonical artist. It must retain:

- `provider` and `provider_entity_id`: currently `musicbrainz` and the exact canonical
  `musicbrainz_artist_id`; the database requires a matching strong `music_identifier` for the
  same artist. No name lookup or inferred identity is valid.
- `provider_response_schema_version` (`musicbrainz-artist-v1`) and `contract_version`
  (`genre-evidence-v1`), so a changed provider shape or project interpretation creates a new,
  inspectable contract.
- provider license class and attribution (`CC0 / CC BY-NC-SA` and `MusicBrainz`), fetch instant in
  UTC epoch milliseconds, and a cache outcome.
- a safe error code only when the lookup did not produce usable evidence. Response bodies, request
  URLs, account values, and any raw rejected payload are never stored.

`cache_state` is `success`, `negative`, or `failure`. A `success` snapshot has outcome `success`
and at least one raw tag; an empty provider tag result is a `negative` `no_tags` snapshot.
`negative` snapshots distinguish `no_tags` and `not_found`; `failure` snapshots distinguish
`malformed_response` and `temporary_failure` and require a safe error code. The refresh policy is
defined in the P5-01 decision: successful and negative snapshots are eligible for explicit refresh
after 180 days, while failures are retryable and never replace a prior successful snapshot. The
database rejects a failure snapshot whose lineage points to a successful predecessor, retaining the
last usable evidence as the applicable successful state.

Refreshing never overwrites a prior row. The newer snapshot records `supersedes_snapshot_id`; the
database enforces that its predecessor belongs to the same artist and provider. Thus freshness is
calculated from a retained fetch instant, and a provider or response-contract change remains
auditable. Snapshots and raw-tag rows are append-only: the database rejects both updates and
deletes, including a cascading delete through an artist. An identity correction therefore retains
its historical enrichment evidence rather than removing it.

## Raw evidence boundary

`genre_enrichment_raw_tag` belongs only to a successful snapshot. It preserves provider tag text,
matching normalization, the provider-relative raw vote weight, nullable provider confidence, and
whether MusicBrainz identifies the tag as a recognized genre. A raw weight is neither a probability
nor a listening-event contribution. `NULL` confidence means the provider did not supply one; it is
not zero confidence. Duplicate normalized tags are rejected per snapshot.

The snapshot/tag tables contain no taxonomy ID, curated category, mapping version, or event ID.
The earlier placeholder `genre_tag`, `artist_genre_evidence`, and `genre_mapping` tables remain
untouched for migration compatibility and receive no P5-02 writes. P5-05 will define the portable
curated mapping workflow; P5-06 will define analytical assignment and event weighting. This keeps
provider evidence, curation, and analysis independently versioned.

## Provider response validation

`src/genre/evidence-contract.ts` validates the normalized, privacy-reviewed result immediately
before persistence. The P5-03 adapter must parse provider JSON outside this contract, discard every
field except the approved snapshot and raw-tag fields, and pass a supported schema version. It must
reject inconsistent state/outcome/error combinations, invalid timestamps or numeric values,
duplicate normalized raw tags, and raw tags attached to non-success results. It must not log or
persist unfiltered provider JSON.
