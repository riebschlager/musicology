# Last.fm API client boundary

P3-01 provides `src/lastfm/client.ts`, the injectable HTTP boundary for the future incremental
`user.getRecentTracks` sync workflow. It sends an identifiable non-secret User-Agent and accepts
only the configured username and API key at construction; neither value is returned in a model or
included in client errors.

`getRecentTracksPage` uses UTC epoch-millisecond input boundaries and serializes them as Last.fm's
inclusive Unix-second `from` and optional `to` parameters. It validates successful HTTP JSON at
runtime, projects only approved completed-scrobble fields, and ignores `@attr.nowplaying` entries
before requiring a completion timestamp. A page may include one current-playing item in addition
to its completed-scrobble limit. `getRecentTracksPages` requests each page with Last.fm's
maximum limit of 200, keeping the explicit inclusive `from` and optional `to` boundaries constant.
It yields projected pages incrementally and stops only after the validated total-page bound is
complete. It rejects a response whose page number repeats or differs from the requested page, or
whose page count, total, or per-page metadata changes during the sequence, or whose completed
records do not match the stable pagination metadata.

P3-05 adds `src/lastfm/persistence.ts`, which accepts only the already validated completed-track
projection and converts it to the shared privacy-reviewed Last.fm evidence shape. It records API
occurrence provenance, links matching export/API evidence, and runs identity, canonical-event, and
reconciliation processing within the ingest lifecycle transaction. Each successful attempt stores
only aggregate response metadata (page, completed-track, and ignored-now-playing counts), bound by
schema to its `lastfm_api_sync` run;
credentials, account identity, URLs, and response bodies are not persisted. P3-06 adds
`sync:lastfm`, documented in [`lastfm-sync.md`](lastfm-sync.md), to orchestrate fetching,
persistence, reconciliation, and cursor advancement.

P3-04 adds `src/lastfm/sync-plan.ts`, a database-backed planning boundary used by the future
`sync:lastfm` command. A normal plan starts from the last successful scope cursor minus the
configurable five-minute safety overlap. If that cursor does not exist, it starts from the newest
approved Last.fm evidence minus the same overlap. An explicit initial UTC epoch-millisecond
boundary takes precedence on a first sync; it is required when no imported evidence exists. The
scope cursor is keyed by a versioned one-way SHA-256 fingerprint of the configured account name,
never the account name itself.

Explicit `from` or `to` boundaries are recovery plans. They are represented with a `preserve`
cursor-update policy, so P3-06 must not advance the normal cursor after such a run. The planner
also exposes a safe, structured dry-run window (`fromEpochMs`, nullable `toEpochMs`, source, and
cursor-update policy) for that command's human and JSON output. Its cursor writer accepts only an
`advance_on_success` plan with a succeeded `lastfm_api_sync` ingest run and never permits the
stored boundary to move backward.

The client has an injectable transport, clock, sleep function, and jitter source for deterministic tests. Each
request has a 15-second timeout and retries at most three times (four total attempts). Transport
failures, timeouts, HTTP 408/425/500/502/503/504 responses, HTTP 429 responses, and Last.fm API
error 29 are retryable. Other HTTP, API, and validation failures stop immediately. The default
backoff starts at one second, doubles per retry, is capped at 30 seconds, and applies ±25% jitter.
These defaults are intentionally conservative and can be overridden by the client options for
tests or a later operational policy.

For rate limits, `Retry-After` is honored as a minimum delay; an HTTP-date form is accepted, and
`X-RateLimit-Reset` is used when `Retry-After` is absent. The exponential backoff component is
bounded by the configured maximum; an explicit server retry directive is honored even when it is
longer. Timeout, transport, HTTP, Last.fm API, rate-limit, invalid-request, and invalid-response
failures are typed `LastfmClientError` categories with safe fixed summaries. Remote response text,
URLs, API keys, and usernames are never copied into those errors.
