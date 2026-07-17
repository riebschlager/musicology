# Phase 4: Initial Analytics

## Objective

Provide stable, coverage-aware analytical views and exports for listening volume, artist eras, rediscovery, and abandonment. Every result must state what it measures, over which evidence, with which timezone, parameters, coverage, version, and as-of date.

## Entry criteria

- Phase 3 gate passes and canonical history includes both historical and synchronized evidence.
- Reconciliation and identity rule versions are queryable.
- Coverage reporting reconciles source and canonical counts.

## Ordered tasks

### P4-01 — Define the analytical result envelope

**Depends on:** Phase 3

**Work:**

- Define a common result contract containing metric/analysis name, definition, date range, presentation timezone, included sources, event count, unresolved rate, parameters, rule/analysis versions, as-of date, and relevant metadata coverage.
- Define deterministic JSON serialization and stable schema versioning.
- Establish how SQL query versions and TypeScript parameter validation are recorded.

**Acceptance:** contract tests reject missing context and invalid parameters; representative results serialize deterministically and include all required disclosure fields.

### P4-02 — Build canonical analytical base views

**Depends on:** P4-01

**Work:**

- Add inspectable SQL views/queries for current canonical events, source backing, canonical artist/track display, Spotify duration evidence, reconciliation status, and explicit calendar projections.
- Ensure presentation timezone is supplied rather than inherited from the machine.
- Keep full-history event availability distinct from Spotify-only duration availability.

**Acceptance:** tests cover UTC/day boundary behavior in `America/Chicago`, alternate timezone grouping, multi-source events counted once, unresolved handling, and source-coverage flags.

### P4-03 — Implement listening-volume analysis

**Depends on:** P4-02

**Work:**

- Implement default `play_count` over every canonical track event at day, ISO week, month, quarter, and year grains.
- Add distinctly named optional duration-thresholded play variants.
- Implement `listened_ms` using Spotify-backed duration only, counting a reconciled event once.
- Add rolling and year-over-year derivations from stable base results.
- Expose `analyze:volume` with validated filters and human/JSON output.

**Acceptance:** tests cover grain boundaries, leap dates, empty periods, short plays, dual-source events, Spotify-only duration labels, rolling windows, and aggregate reconciliation.

### P4-04 — Specify artist-era parameters and components

**Depends on:** P4-02

**Work:**

- Define window size, rolling play count, share of listening, rank, consecutive activity, earlier-baseline change, and minimum absolute activity components.
- Choose documented defaults using synthetic examples and local sensitivity inspection; keep every parameter configurable.
- Define interval start/end, peak, strength, play count, share, and evidence fields.

**Acceptance:** a written metric definition and examples make every component and default reproducible; low-volume dominance and boundary behavior have tests.

### P4-05 — Implement artist-era analysis

**Depends on:** P4-04

**Work:**

- Calculate per-window artist components and assemble qualifying consecutive windows into intervals.
- Preserve component values so strength remains explainable.
- Add `analyze:artist-eras` with stable structured output and coverage disclosures.

**Acceptance:** synthetic histories cover rising, sustained, fading, overlapping, and insufficient-activity artists; results are deterministic under evidence insertion-order changes.

### P4-06 — Specify and implement rediscovery analysis

**Depends on:** P4-02, P4-05

**Work:**

- Define configurable absence thresholds (including 90, 180, and 365-day scenarios), prior-importance criteria, return window, persistence criteria, and artist/track scope.
- Classify one-off return, sustained rediscovery, and return beginning a new era.
- Emit prior listen, gap length, return intensity, persistence, related era, parameters, and evidence.
- Add `analyze:rediscovery`.

**Acceptance:** tests cover exact threshold boundaries, never-important entities, one-off/sustained returns, repeated rediscoveries, and open-ended current returns.

### P4-07 — Specify and implement abandonment analysis

**Depends on:** P4-02, P4-05, P4-06

**Work:**

- Define historical importance, last listen, former cadence, active periods, observation window, right-censoring, and confidence components.
- Report only `dormant` or `likely_abandoned_as_of`, never a permanent fact.
- Make later rediscovery supersede or invalidate earlier as-of conclusions without erasing historical results.
- Add `analyze:abandonment`.

**Acceptance:** tests cover right-censored recent artists, historically minor artists, stable dormancy, likely abandonment, later rediscovery, and changing as-of dates.

### P4-08 — Build versioned analytical exports

**Depends on:** P4-03, P4-05, P4-06, P4-07

**Work:**

- Export volume, artist eras, rediscovery, abandonment, and coverage to a documented, versioned format suitable for a future web layer.
- Use deterministic filenames/content or an explicit manifest strategy.
- Include input database state/rule versions so stale outputs can be detected.
- Keep private raw evidence out of exports by default.

**Acceptance:** schema tests validate each artifact; repeated unchanged runs yield equivalent analytical data; stale-version detection works; exports can be consumed without reading raw source tables.

### P4-09 — Validate analyses on the archive and document interpretation

**Depends on:** P4-01 through P4-08

**Work:**

- Run all analyses over the local archive and reconcile totals to coverage reports.
- Inspect early sparse years, the 2017–2024 Last.fm gap, overlap years, recent right-censoring, and Spotify-only duration coverage.
- Document metric definitions, limitations, example commands, and interpretation cautions using aggregate/non-sensitive examples.
- Add performance checks for representative full-archive workloads.

**Acceptance:** every analysis has a documented contract, tests, reproducible output, acceptable local runtime, and visible coverage/uncertainty metadata.

## Phase gate

Phase 4 is complete when all four insight families and coverage can be regenerated from canonical history, reproduce stable results, reconcile to base counts, and disclose definitions, parameters, source coverage, unresolved data, timezone, version, and uncertainty.

