# Phase 3: Incremental Last.fm Synchronization

## Objective

Add an idempotent, bounded, failure-safe Last.fm `user.getRecentTracks` synchronization workflow that reuses the historical evidence and reconciliation pipeline and advances its cursor only after complete success.

## Entry criteria

- Phase 2 gate passes.
- Last.fm source fingerprints and export/API overlap semantics are stable.
- Required environment variable names are documented and ignored secret storage is available locally.

## Ordered tasks

### P3-01 — Define the Last.fm client boundary and validated response model

**Depends on:** Phase 2

**Work:**

- Define request parameters, completed-track response shape, pagination metadata, typed error categories, timeouts, and injectable transport/clock interfaces.
- Runtime-validate HTTP and JSON responses.
- Identify and ignore currently playing items without completed scrobble timestamps.
- Set an identifiable non-secret User-Agent and prevent URLs/errors from exposing API keys.

**Acceptance:** mocked tests cover valid pages, now-playing items, malformed payloads, HTTP errors, Last.fm API errors, redaction, and UTC boundary serialization.

### P3-02 — Implement bounded pagination

**Depends on:** P3-01

**Work:**

- Request JSON pages with a limit of 200 and explicit inclusive `from` plus optional `to` boundaries.
- Follow validated pagination metadata until the bounded result is complete.
- Detect inconsistent, repeated, or unexpectedly changing pagination and fail safely.
- Return pages incrementally without retaining unnecessary response copies.

**Acceptance:** deterministic tests cover one page, multiple pages, empty windows, exact boundary records, changing page counts, and repeated-page protection.

### P3-03 — Add bounded retries and rate-limit behavior

**Depends on:** P3-01, P3-02

**Work:**

- Add request timeout, bounded exponential backoff with jitter, transient-error classification, and explicit rate-limit handling.
- Respect relevant response retry/cache headers where applicable.
- Make clock, sleep, and jitter injectable for fast deterministic tests.
- Document conservative request and retry defaults.

**Acceptance:** tests prove transient recovery, retry exhaustion, non-retryable failure, rate-limit delay, timeout behavior, and no unbounded request loop.

### P3-04 — Implement cursor and safety-overlap planning

**Depends on:** P3-02

**Work:**

- Read the last successful cursor and subtract a configurable safety overlap.
- Support explicit `from`/`to` overrides for recovery without silently corrupting normal cursor state.
- Define first-sync behavior from the latest imported evidence or an explicit boundary.
- Represent the proposed request window in dry-run output.

**Acceptance:** tests cover no cursor, normal overlap, epoch/timezone boundaries, explicit bounds, invalid ranges, and cursor monotonicity.

### P3-05 — Persist API scrobbles through shared evidence contracts

**Depends on:** P3-01 through P3-04

**Work:**

- Convert completed API tracks to the approved Last.fm source-evidence shape.
- Upsert using the stable fingerprint so safety overlap and export/API overlap do not create extra analytical events.
- Record API origin and safe response/run metadata without storing the API key or unfiltered body.
- Reuse identity and reconciliation processing for newly inserted evidence.

**Acceptance:** overlap fixtures reuse/link evidence correctly; repeats insert nothing; now-playing items never persist; new records receive canonical or explicit unresolved interpretations.

### P3-06 — Implement atomic synchronization orchestration

**Depends on:** P3-03, P3-04, P3-05

**Work:**

- Add `sync:lastfm` with bounded recovery flags, dry-run, human output, and JSON output.
- Record the operation lifecycle and advance the cursor only after all pages and required persistence/reconciliation succeed.
- Leave the cursor unchanged after any transport, validation, persistence, or reconciliation failure.
- Ensure dry-run performs requests/validation as documented but persists nothing.

**Acceptance:** simulated page, insert, and reconciliation failures leave no partial evidence and do not advance the cursor; successful repeat sync is a no-op; summaries reconcile fetched, ignored, existing, inserted, and matched counts.

### P3-07 — Add operational validation and recovery documentation

**Depends on:** P3-06

**Work:**

- Extend validation for cursor/run consistency and API/export evidence overlap.
- Document secret setup, initial sync, regular sync, dry-run, bounded recovery, rate limiting, and safe failure recovery.
- Add a local smoke procedure that never prints credentials.

**Acceptance:** a user can recover an interrupted or missed window from documentation; validation detects impossible cursor/run state; no credential appears in captured logs or test snapshots.

### P3-08 — Verify against the live account safely

**Depends on:** P3-01 through P3-07

**Work:**

- Run a narrow dry-run window, then the same bounded live sync with local credentials.
- Repeat the window and confirm no new evidence or canonical events.
- Simulate or safely test a recoverable failure if practical, then confirm cursor behavior.
- Run coverage and integrity validation and record only aggregate findings.

**Acceptance:** repeated synchronization adds only newly observed scrobbles, current-playing data is ignored, the cursor reflects the last wholly successful run, and no secrets or private raw responses enter Git.

## Phase gate

Phase 3 is complete when a failed or interrupted sync cannot advance the cursor or leave partial results, safety overlap is harmless, historical/API overlap does not double-count, and repeat synchronization is demonstrably idempotent.

