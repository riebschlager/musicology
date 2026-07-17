# Phase 2: Identity and Reconciliation

## Objective

Turn source evidence into canonical music identities and listening events while preserving every source link, automatically resolving only strong and unambiguous cases, and retaining explainable candidates and manual decisions for everything uncertain.

## Entry criteria

- Phase 1 gate passes and source evidence is stable.
- The database can be rebuilt from historical inputs without loss.
- A private local database is available for aggregate calibration, but CI remains fixture-only.

## Ordered tasks

### P2-01 — Specify and implement versioned normalization

**Depends on:** Phase 1

**Work:**

- Define pure, versioned normalization for Unicode, case, whitespace, punctuation, and narrowly scoped featuring-artist notation.
- Preserve qualifiers such as live, remix, radio edit, version, and movement text.
- Store original display text separately from normalized matching values.
- Document normalization changes as rule-version changes, not silent rewrites.

**Acceptance:** table-driven tests cover Unicode equivalence, punctuation, whitespace, featuring notation, meaningful qualifiers, blank values, and deterministic output.

### P2-02 — Resolve strong identifiers and create initial identities

**Depends on:** P2-01

**Work:**

- Create or reuse artists, releases, tracks, aliases, and external identifiers from source evidence.
- Apply resolution priority: manual decision, trusted strong identifier, known alias, conservative composite, then new unresolved identity.
- Reject automatic identity merges when strong identifiers conflict.
- Make processing order-independent and idempotent.

**Acceptance:** fixture permutations produce the same identities; trusted identifier reuse works; missing albums stay unknown; conflicts remain separate and inspectable.

### P2-03 — Create canonical events for unique evidence

**Depends on:** P2-02

**Work:**

- Create an initial listening event for each unique, non-duplicate source interpretation.
- Attach every event to its evidence with source role, rule version, and applicable derived-time metadata.
- Retain short and skipped Spotify plays.
- Represent unresolved identity/event states explicitly rather than dropping records.

**Acceptance:** every accepted source music record has exactly one current interpretation or explicit unresolved state; every event has at least one source link.

### P2-04 — Collapse exact within-source duplication at the event layer

**Depends on:** P2-03

**Work:**

- Link exact duplicated Spotify source rows to one event while retaining all evidence rows.
- Coalesce Last.fm export/API-equivalent evidence according to the stable fingerprint policy in preparation for Phase 3.
- Do not collapse same-time records with materially different fields unless a documented rule proves equivalence.

**Acceptance:** exact duplicate fixtures yield one event with multiple evidence links; legitimate repeated listens remain distinct; source row counts never decrease.

### P2-05 — Generate bounded cross-source candidates

**Depends on:** P2-01 through P2-04

**Work:**

- Generate Spotify/Last.fm pairs using indexed time blocks plus compatible artist/track identities or normalized text.
- Use Spotify-derived start time and a tightly bounded configurable window.
- Store why each pair entered the candidate set and the candidate-generation rule version.
- Prove the query avoids an all-pairs scan.

**Acceptance:** known matches enter the candidate set; unrelated and out-of-window evidence does not; query-plan/performance tests use indexes on representative synthetic volume.

### P2-06 — Calculate explainable match features

**Depends on:** P2-05

**Work:**

- Calculate and persist identifier, artist, track, album, time-distance, duration/plausibility, neighboring-order, competing-candidate, and short-play features.
- Define score direction and missing-feature behavior explicitly.
- Keep feature values separate from the aggregate score.

**Acceptance:** boundary tests cover exact and near times, missing albums, conflicting identifiers, short plays, reordered neighbors, ties, and deterministic scoring.

### P2-07 — Calibrate and version the decision policy

**Depends on:** P2-06

**Work:**

- Build a privacy-safe local sampling/export tool for labeling representative overlap candidates.
- Use the labeled sample to select high-confidence, review, and ignore thresholds with a recorded rationale biased against false merges.
- Encode hard rules: strong-identifier conflicts never auto-merge; competing equally plausible candidates remain ambiguous.
- Version the thresholds, features, and rationale together.

**Acceptance:** policy tests cover thresholds and hard conflicts; the calibration artifact contains no private raw records if committed; changing a policy requires a new version.

### P2-08 — Apply reconciliation decisions reproducibly

**Depends on:** P2-07

**Work:**

- Add `reconcile` with rule-version and dry-run options.
- Auto-merge only high-confidence, unambiguous candidates; retain medium-confidence pairs for review and low-confidence records separately.
- Supersede prior automatic decisions without erasing their audit history.
- Update canonical events and evidence links in a transaction.

**Acceptance:** dry-run makes no changes; interrupted runs roll back; same-rule reruns are no-ops; ambiguous and conflicting cases stay separate; all merges remain explainable from stored features.

### P2-09 — Add manual review and portable decision artifacts

**Depends on:** P2-08

**Work:**

- Decide and document the privacy/versioning format for manual identity and reconciliation decisions.
- Export inspectable candidates without secrets or excluded source fields.
- Validate and import merge, split, alias, accept, and reject decisions with stable references.
- Back up the database before bulk decision imports and make manual decisions override automatic rules reproducibly.

**Acceptance:** export/import round-trips on a rebuilt fixture database; invalid or stale references fail safely; decisions are auditable and can be reapplied without duplication.

### P2-10 — Extend canonical validation and coverage

**Depends on:** P2-01 through P2-09

**Work:**

- Validate event/source cardinality, unresolved states, conflicting identifiers, decision lineage, rule versions, and orphan-free identity graphs.
- Extend coverage reporting with canonical counts, source backing (Spotify/Last.fm/both), exact/inferred merge counts, unresolved rates, and overlap by year.
- Run full archive reconciliation and inspect aggregate results around known overlap years and gaps.

**Acceptance:** coverage totals reconcile through source links; archive invariants pass; surprising merge rates or conflicts are investigated before the phase closes.

## Phase gate

Phase 2 is complete when every accepted track record has a canonical or explicit unresolved interpretation, source evidence remains intact, exact duplicates do not inflate canonical counts, cross-source merges are conservative and explainable, and manual decisions survive a rebuild.

