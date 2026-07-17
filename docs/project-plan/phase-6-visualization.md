# Phase 6: Visualization and Artifact Layer

## Objective

Build a local-first interface and static artifacts over versioned analytical contracts. The presentation layer must make source gaps, metric scope, reconciliation uncertainty, enrichment coverage, parameters, and as-of dates visible rather than requiring knowledge of raw export formats.

## Entry criteria

- Phase 4 analytical exports and coverage contracts are stable and versioned.
- Phase 5 genre contracts are stable enough to include, or genre views are explicitly deferred/experimental.
- No visualization requires direct access to private source files.

## Ordered tasks

### P6-01 — Define user journeys and information hierarchy

**Depends on:** Phase 4; Phase 5 status known

**Work:**

- Define the first journeys: history overview, volume exploration, artist era exploration, rediscovery, dormancy/likely abandonment, data coverage, and optional genre eras.
- Identify the question, default view, filters, drill-down, uncertainty disclosure, empty state, and export action for each journey.
- Establish accessibility, responsive-layout, and local-only privacy requirements.

**Acceptance:** a concise product specification maps each view to an existing analytical contract and contains no requirement to query raw export formats.

### P6-02 — Select and document the web/visualization stack

**Depends on:** P6-01

**Work:**

- Evaluate options against local-first startup, TypeScript integration, static/server data loading, chart accessibility, bundle complexity, maintenance, and analytical-contract compatibility.
- Choose the smallest stack that supports the journeys and record alternatives and rationale.
- Define whether the single package remains sufficient or a package boundary is now justified; do not create a monorepo without demonstrated need.

**Acceptance:** the decision record names deployment/runtime, data-loading, charting, testing, and accessibility strategies before UI scaffolding begins.

### P6-03 — Implement the analytical data adapter

**Depends on:** P6-02

**Work:**

- Validate and load versioned analytical exports or a narrow project-owned read API.
- Reject incompatible/stale schemas with actionable messages.
- Expose typed view models without leaking database/source-table details into components.
- Provide deterministic fixture datasets for UI tests and component development.

**Acceptance:** adapter tests cover each artifact, missing/old versions, empty history, incomplete genre coverage, and offline/local operation.

### P6-04 — Build the shared application shell and disclosure system

**Depends on:** P6-03

**Work:**

- Build navigation, date/timezone controls, metric definitions, source/coverage indicators, loading/error/empty states, and accessible responsive layout.
- Create reusable disclosure components for Spotify-only duration, gaps, unresolved proportion, genre coverage/freshness, parameters, and as-of dates.
- Ensure colors and interactions do not carry meaning without text or accessible alternatives.

**Acceptance:** automated accessibility checks and keyboard tests pass; every view can display its analytical envelope and coverage warnings consistently.

### P6-05 — Implement history volume and coverage views

**Depends on:** P6-04

**Work:**

- Add interactive time-grain and date-range exploration for play count and clearly distinct Spotify-only listened time.
- Overlay or align source coverage, gaps, and suspicious discontinuities.
- Provide accessible tabular alternatives and data export.

**Acceptance:** a user cannot mistake duration for full-history coverage; 2017–2024 Last.fm absence and other gaps are visible; totals match fixture analytical outputs.

### P6-06 — Implement artist-era exploration

**Depends on:** P6-04

**Work:**

- Visualize artist intervals, peaks, strength, share, overlap, and component evidence.
- Support parameter visibility and bounded comparison/filtering without implying eras are permanent labels.
- Provide accessible detail and table views.

**Acceptance:** interval boundaries and component values match analytical fixtures; sparse-data cases and overlapping eras remain legible and qualified.

### P6-07 — Implement rediscovery and abandonment views

**Depends on:** P6-04

**Work:**

- Show prior listen, absence gap, return intensity, persistence, related era, and rediscovery class.
- Present dormancy/likely abandonment with as-of date, confidence components, observation window, and right-censoring warnings.
- Make later rediscovery visibly invalidate older abandonment conclusions where represented.

**Acceptance:** wording never states abandonment as fact; all classifications expose supporting parameters/evidence and match analytical fixture results.

### P6-08 — Implement genre-era views when fit for use

**Depends on:** Phase 5 gate and P6-04

**Work:**

- If Phase 5 declared results fit for use, visualize weighted genre intervals with raw/curated modes, provider, taxonomy, freshness, weighting level, and coverage.
- If experimental, place the view behind an explicit experimental status with limitations, or defer it and record the gate for later activation.

**Acceptance:** no genre chart appears without visible coverage and taxonomy context; partial enrichment is never plotted as though it covers all events.

### P6-09 — Add static artifact generation

**Depends on:** P6-05 through P6-08 as applicable

**Work:**

- Add selected privacy-reviewed static exports such as images, printable reports, or exchange files derived from the same view models.
- Include generation/version/coverage context in each artifact.
- Define explicit opt-in if an artifact contains personally revealing listening details.

**Acceptance:** artifacts reproduce view totals, contain required disclosures, and never include excluded source fields or secrets.

### P6-10 — Complete end-to-end, accessibility, privacy, and performance verification

**Depends on:** P6-01 through P6-09

**Work:**

- Test from a rebuilt fixture database through analytics generation to rendered views/artifacts.
- Add critical browser journeys, visual regression where stable, keyboard/screen-reader checks, and representative performance budgets.
- Perform a privacy review of bundled data, network behavior, logs, errors, and exports.
- Document local setup, regeneration, troubleshooting, and artifact sharing cautions.

**Acceptance:** the app works offline/local as designed; UI totals match analytics; quality/accessibility budgets pass; no raw private export or excluded field is shipped; a fresh checkout can reproduce the fixture experience.

## Phase gate

Phase 6 is complete when the first user journeys work over stable analytical interfaces, communicate source/coverage/uncertainty honestly, pass accessibility and privacy review, and require no knowledge of raw Spotify or Last.fm formats.

