# Phase 5: Genre Enrichment and Genre Eras

## Objective

Add genre as optional, independently refreshable evidence with provider provenance, raw tags, curated mappings, weights, confidence, and coverage-aware era analysis. Genre failure must never block core ingestion or non-genre analytics.

## Entry criteria

- Phase 4 gate passes and artist-era/base analytical contracts are stable.
- Artist identities have sufficient stability for enrichment keys.
- Provider selection remains open until the first task is completed.

## Ordered tasks

### P5-01 — Evaluate provider and taxonomy options

**Depends on:** Phase 4

**Work:**

- Compare candidate metadata sources for licensing/terms, authentication, request limits, cacheability, artist/track coverage, tag weights, freshness, identity mapping, and local-first reproducibility.
- Compare raw-tag-only, curated taxonomy, and hybrid strategies.
- Select the minimum viable provider set and taxonomy approach, or explicitly defer implementation if no option meets project constraints.
- Record the decision, alternatives, refresh policy, and privacy implications.

**Acceptance:** a committed decision record supports the choice with reproducible aggregate sampling and identifies all credentials/configuration without containing secrets.

### P5-02 — Define the enrichment evidence contract

**Depends on:** P5-01

**Work:**

- Define provider response validation, raw evidence, fetch date, provider/entity identifier, weight, confidence, cache state, error, and schema/version contracts.
- Define how refreshed evidence supersedes rather than erases prior snapshots.
- Keep raw tags separate from curated mappings and analytical assignments.

**Acceptance:** schema/contract tests preserve provider, freshness, raw weight, and lineage; core tables and commands remain usable with no enrichment data.

### P5-03 — Implement a cached, resumable enrichment client

**Depends on:** P5-02

**Work:**

- Implement provider adapter(s) behind a project-owned boundary with validation, timeouts, bounded retries, rate limits, and safe logging.
- Cache successful evidence and appropriate negative results according to the documented refresh policy.
- Add bounded, dry-run, resume, and refresh modes.

**Acceptance:** mocked tests cover success, missing entity, ambiguous identity, malformed response, rate limiting, retry exhaustion, cache hit, refresh, interruption, and secret redaction.

### P5-04 — Persist artist-genre evidence with provenance

**Depends on:** P5-03

**Work:**

- Resolve provider entities conservatively to canonical artists.
- Store raw tags/weights/confidence with provider and fetch metadata.
- Leave ambiguous provider matches unresolved for review rather than attaching them automatically.
- Add validation and coverage summaries for enriched, missing, ambiguous, stale, and failed artists/events.

**Acceptance:** reruns are idempotent within a snapshot; refreshes retain lineage; ambiguous matches do not contaminate canonical artists; evidence coverage reconciles to artist/event counts.

### P5-05 — Build the versioned genre mapping workflow

**Depends on:** P5-04

**Work:**

- Define a portable curated mapping artifact from noisy provider tags to analytical genre categories.
- Support keep, combine, rename, ignore, and parent/child mapping decisions without deleting raw tags.
- Validate cycles, duplicate/conflicting mappings, unknown tags, and taxonomy version changes.

**Acceptance:** mapping import/export round-trips; invalid taxonomies fail safely; changing taxonomy produces a new version and does not rewrite raw evidence.

### P5-06 — Calculate weighted genre contributions

**Depends on:** P5-05

**Work:**

- Define and implement artist-to-event genre weighting, including multi-tag fractional contribution and normalization.
- Offer raw and curated tag modes and identify artist-level versus track-level evidence explicitly.
- Calculate usable-coverage denominators without treating unenriched events as a genre.

**Acceptance:** contribution sums and rounding behavior are tested; missing enrichment remains missing; provider, taxonomy, freshness, weighting level, and coverage accompany results.

### P5-07 — Implement genre-era analysis

**Depends on:** P5-06 and the Phase 4 era components

**Work:**

- Adapt the era component/interval approach to weighted genre contributions.
- Add configurable thresholds appropriate to fractional counts.
- Emit interval strength, peak, contribution/share, taxonomy version, provider/fetch age, raw/curated mode, weighting level, and coverage.
- Add a versioned structured export.

**Acceptance:** synthetic histories cover overlapping, rising, fading, sparse-coverage, and taxonomy-change cases; low-coverage output is visibly qualified rather than silently presented as complete.

### P5-08 — Run archive enrichment and assess fitness

**Depends on:** P5-01 through P5-07

**Work:**

- Enrich the local archive in resumable batches and run integrity/coverage checks.
- Inspect aggregate coverage by year and historically important artists.
- Document known provider/taxonomy biases and determine whether coverage is sufficient for user-facing genre-era results.
- If insufficient, retain the evidence pipeline but mark genre analytics experimental and record the next evidence needed.

**Acceptance:** genre results are reproducible independently of core ingestion and always report taxonomy, weighting, provider, freshness, and usable event coverage.

## Phase gate

Phase 5 is complete when genre evidence can be refreshed or rebuilt without changing core history, raw and curated tags remain traceable, and genre-era output is either coverage-qualified and fit for use or explicitly marked experimental with documented evidence gaps.

