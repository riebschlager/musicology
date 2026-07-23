# Genre enrichment client

P5-03 supplies the optional MusicBrainz client boundary. It makes one read-only request per
canonical artist only when the caller has already established an exact strong
`musicbrainz_artist_id`. It does not search names, infer provider identities, persist to SQLite,
or add a CLI command; P5-04 owns the SQLite snapshot-cache implementation and command workflow.

The client requests the selected fixed endpoint and User-Agent from the Phase 5 provider decision,
uses a 15-second timeout that remains active through response-body validation, at most three retries
with bounded exponential delays, and observes a
minimum one-second interval between requests. It retries transport errors, timeouts, `429`, and
HTTP `408`, `425`, `500`, `502`, `503`, and `504`; other HTTP responses fail once with a safe typed
error. A `429` honors `Retry-After` when present. It
allowlist-projects only the provider ID, tag name, vote count, and recognized-genre flag. Remote
response bodies, URLs, and other fields are discarded and never logged or stored.

The evidence contract permits one row per normalized raw tag. When MusicBrainz returns the same
normalized value in both `tags` and `genres`, the recognized-genre value deterministically supplies
the retained spelling and vote count, and its recognized flag is retained. Duplicate normalized
values within either provider collection remain malformed responses.

`enrichArtists` takes a project-owned snapshot-cache boundary and processes targets in input order.
It records each completed result before continuing, so a later run resumes from successful and
negative (`no_tags` or `not_found`) cache entries. Failures stay retryable. `dryRun` fetches and
validates without recording; `limit` bounds the number of targets considered; `refresh` re-fetches
only successful or negative entries at least 180 days old. A refresh retains lineage by assigning
the preceding snapshot ID; a failure never supersedes usable evidence.

The client uses no credential or environment variable. It returns only safe error codes defined by
the genre evidence contract. An artist without an exact MusicBrainz ID is skipped as
`ambiguous_identity` rather than queried by name.

P5-04 adds `pnpm enrich:genres`, which uses the cache and processes current or unresolved canonical
artists in descending event-count then ID order. `--limit` bounds considered artists, `--dry-run`
does not persist snapshots, and `--refresh` applies the documented age policy. Its summary contains
aggregate actions and a versioned coverage partition only; it never prints artist names, IDs, tags,
provider response bodies, or source evidence. The partition is mutually exclusive: fresh successful
evidence is `enriched`, a negative/no result is `missing`, no unique exact strong MusicBrainz ID is
`ambiguous`, aged usable evidence is `stale`, and an otherwise unusable latest failure is `failed`.
Artist and canonical-event counts reconcile exactly across these states.
