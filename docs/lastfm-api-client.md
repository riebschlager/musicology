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
records do not match the stable pagination metadata. Persistence and cursor updates remain deferred
to their respective Phase 3 tasks.

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
