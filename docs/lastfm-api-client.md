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
records do not match the stable pagination metadata. Retry policy,
persistence, and cursor updates remain deferred to their respective Phase 3 tasks.

The client has an injectable transport and clock for deterministic tests. A request timeout is
enabled by default; timeout, transport, HTTP, Last.fm API, invalid-request, and invalid-response
failures are typed `LastfmClientError` categories with safe fixed summaries. Remote response text
and URLs are never copied into those errors.
