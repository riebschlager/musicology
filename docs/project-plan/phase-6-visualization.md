# Phase 6: Public Music-History Microsite

## Objective

Publish a narrative-first, accessible microsite at `music.the816.com` that lets visitors explore a
privacy-reviewed version of the listening history without turning the local-first laboratory into a
hosted application. The production site must be a static GitHub Pages artifact built from an
explicitly approved, versioned public snapshot rather than from private inputs, the local SQLite
database, or the private analytical bundle at runtime.

The experience should lead with the long arc of the listening history, then support deeper
artist-era exploration, selected track stories, rediscovery, dormancy, and data coverage. Every
view must make source gaps, metric scope, reconciliation uncertainty, enrichment coverage,
parameters, and as-of dates visible without requiring knowledge of raw export formats.

## Entry criteria

- Phase 4 analytical exports and coverage contracts are stable and versioned.
- Phase 5 genre contracts are stable enough to support an explicitly experimental view, or genre
  presentation is deferred.
- No presentation requirement needs direct access to private source files or source-shaped tables.
- The repository remains one pnpm package unless P6-03 documents a demonstrated boundary requiring
  otherwise.

## Phase invariants

- Ingestion, reconciliation, enrichment, and analysis remain local-first and rebuildable. GitHub
  Pages is a publication target, not an operational database or analytical runtime.
- The existing analytical bundle remains private derived personal data and is never published
  unchanged.
- Production consumes only a narrow, schema-validated public snapshot produced through an explicit
  allowlist and manual review step.
- A synchronization, import, enrichment, or analysis run never publishes data automatically.
- No secret or database credential is shipped to the browser. The initial production architecture
  has no hosted query service, runtime API, Turso dependency, or visitor account system.
- Public artist detail is limited by documented significance/eligibility rules. Track detail appears
  only in manually selected editorial stories; the site never exposes an event-level listening log.
- Full-history play counts remain visibly distinct from Spotify-backed duration, completion, skip,
  and thresholded metrics.

## Ordered tasks

### P6-01 — Define the public narrative, journeys, and information hierarchy

**Depends on:** Phase 4; Phase 5 fitness status known

**Work:**

- Define the public audience and the narrative promise: a long-form personal music history with an
  analytical explorer, not an internal dashboard or generic streaming recap.
- Specify the first routes and journeys: narrative overview/long view, history and coverage,
  artist-era exploration, selected artist detail, curated rediscovery and dormancy stories, a
  deeper explorer, methodology, and an optional experimental genre lab.
- For each journey, document its question, narrative role, default view, filters, URL-addressable
  state, drill-down, supporting analytical contract, uncertainty disclosure, empty state, tabular
  alternative, and bounded export/share action.
- Define the editorial content model for annotations, featured artists, and selected track stories
  without embedding private archive records in authored content.
- Establish responsive, keyboard, screen-reader, reduced-motion, color/contrast, progressive
  enhancement, and no-JavaScript expectations.

**Acceptance:** a concise product specification maps every route and interaction to stable
analytical inputs or explicitly authored public content, identifies the first-release narrative,
and contains no requirement to query raw exports, SQLite, or a hosted service.

### P6-02 — Define the public-data and publication privacy contract

**Depends on:** P6-01

**Work:**

- Classify every candidate field as private-only, public aggregate, eligible artist detail, or
  manually selected editorial detail.
- Define public date granularity, artist eligibility/significance rules, long-tail suppression,
  selected-track allowlisting, stable public slugs, result limits, and treatment of small or sparse
  groups.
- Define selected-track artist/track display identity as wholly manual reviewed editorial detail,
  independent of private analytical candidate availability and incapable of creating track-level
  analytical evidence.
- Exclude individual listening events, private analytical-bundle passthrough, internal/source IDs,
  source paths and filenames, fingerprints, raw provider payloads, credentials, and all previously
  excluded sensitive fields.
- Define a versioned public manifest and artifact schemas with generation version, analytical
  versions, timezone, as-of date, publication date, coverage, hashes, and selection-policy version.
- Define the manual approval, diff/report, withdrawal, rollback, and supersession workflow. Specify
  which generated public artifacts are intentionally committed and how they remain distinguishable
  from ignored private outputs.
- Decide and document policies for downloadable data, external links, artwork/licensing, fonts,
  visitor analytics, third-party requests, and site privacy disclosure.

**Acceptance:** contract and privacy tests can prove the public schema is allowlisted, rejects an
unknown or forbidden field, applies the chosen granularity and selection rules, treats manual track
identity as editorial rather than analytical evidence, and cannot express an event-level listening
log. A reviewer can determine exactly what a proposed snapshot would make public before approving
it.

### P6-03 — Confirm and document the static web/visualization stack

**Depends on:** P6-01 and P6-02

**Work:**

- Confirm Astro static output for the narrative shell, Preact islands for bounded interactive
  explorers, Observable Plot for accessible analytical charts, and project-owned SVG only where an
  era visualization cannot be expressed adequately through the chart library.
- Verify compatibility with the pinned Node.js 24/pnpm 9 single-package toolchain and static GitHub
  Pages deployment before adding dependencies.
- Record alternatives and rationale against static output, TypeScript integration, progressive
  enhancement, bundle cost, chart composition, accessibility, maintenance, testability, and public
  snapshot compatibility.
- Define project-owned adapter, view-model, component, content, style, and page boundaries without
  coupling the site to SQLite or source-table representations.
- Define unit/component testing, browser testing, accessibility automation, visual-regression
  scope, performance budgets, and supported-browser policy.

**Acceptance:** a decision record names the build/runtime, data-loading, charting, interaction,
styling, testing, accessibility, and GitHub Pages strategies. It explains why no hosted database,
server runtime, or monorepo is required for the initial microsite.

### P6-04 — Implement the private-to-public snapshot pipeline

**Depends on:** P6-02 and P6-03

**Work:**

- Validate and load the stable private analytical bundle through a project-owned adapter; reject
  missing, stale, incompatible, or internally inconsistent artifacts with sanitized actionable
  errors.
- Project only the P6-02 allowlisted fields and aggregations into the versioned public artifacts,
  applying public date granularity, artist eligibility, result bounds, and editorial selections.
- Treat selected-track artist/track display identity as wholly manual reviewed editorial detail.
  Do not require a private analytical track candidate, and do not attach track-level analytical
  evidence merely because a manual track identity is present.
- Produce deterministic filenames, serialization, hashes, and a manifest; stage the complete
  snapshot before replacing a prior generated candidate.
- Produce a deterministic publication report and human-reviewable diff summary covering exposed
  fields, entity/story counts, date ranges, versions, coverage, additions, removals, and material
  granularity changes without echoing private rejected payloads.
- Keep candidate generation separate from explicit approval. An approved snapshot must be
  reproducible, identifiable, and capable of being rolled back without regenerating private data.
- Add small deterministic public fixture snapshots for site development and tests.

**Acceptance:** tests cover every public artifact plus empty history, incompatible/stale private
input, forbidden and unknown fields, date reduction, threshold boundaries, wholly manual
track-story identity (including duplicate, missing-story, and unreviewed-name failures),
deterministic reruns, failed staging, snapshot supersession, and rollback. Tests also prove a manual
track selection neither requires a private analytical candidate nor creates track-level analytical
evidence. The output contains no private-only field and does not require the local database after
generation.

### P6-05 — Build the narrative shell and disclosure system

**Depends on:** P6-03 and P6-04

**Work:**

- Build the static route shell, navigation, typography, responsive layout, shared metadata,
  canonical URLs, social metadata, not-found page, and a cohesive visual language appropriate to a
  personal music-history publication.
- Build reusable narrative-section, chart, annotation, filter, table, loading/error/empty-state,
  and editorial-story components.
- Build consistent disclosures for metric definitions, Spotify-only duration, source gaps,
  unresolved proportion, genre coverage/freshness, analytical parameters, timezone, and as-of and
  publication dates.
- Make meaningful route and explorer state directly linkable while preserving usable static
  content and methodology when JavaScript is unavailable.
- Ensure color, motion, hover, and spatial position never carry meaning without text or another
  accessible representation.

**Acceptance:** the complete route shell builds as static files, works responsively with keyboard
and reduced-motion settings, exposes consistent analytical envelopes, and provides meaningful
content and navigation before optional interactive islands hydrate.

### P6-06 — Implement the long-view history and coverage experience

**Depends on:** P6-05

**Work:**

- Create the narrative homepage around a long-view timeline spanning the retained history, with
  authored context and clear paths into deeper exploration.
- Add interactive time grain and bounded date-range exploration for full-history play count and
  clearly distinct Spotify-backed listened time or thresholded metrics when public-contract
  coverage permits them.
- Align listening volume with source coverage, gaps, overlap, and suspicious discontinuities so
  apparent behavioral changes are not separated from evidence quality.
- Make the known 2017–2024 Last.fm absence, Last.fm-only early history, and the right-censored recent
  edge visible and understandable.
- Provide accessible summaries and tables plus privacy-reviewed view-level downloads where P6-02
  permits them.

**Acceptance:** a visitor cannot mistake duration for full-history coverage or a source gap for an
absence of listening. Totals match the public fixture/view models, URL state is reproducible, and
the principal long-view findings are available without interpreting the chart visually.

### P6-07 — Implement artist-era exploration and eligible artist detail

**Depends on:** P6-05

**Work:**

- Visualize eligible artist intervals, peaks, strength, share, overlap, and component evidence as
  parameterized signals rather than permanent labels.
- Support bounded search, comparison, filtering, and URL-addressable artist/range selection without
  loading or exposing the private long tail.
- Generate static, indexable artist detail only for entities admitted by the P6-02 eligibility
  policy. Show public monthly/period summaries and era context rather than individual plays.
- Connect authored featured-artist context and selected track stories without treating editorial
  interpretation as analytical fact.
- Provide textual summaries and table views for era intervals and component values.

**Acceptance:** public artist eligibility is enforced before build/render, interval boundaries and
components match public fixtures, sparse and overlapping eras remain qualified, selected track
detail comes only from the editorial allowlist, and no page reconstructs an event-level history.

### P6-08 — Implement curated rediscovery and dormancy stories

**Depends on:** P6-05 and P6-07

**Work:**

- Present selected artist and track returns with reduced-date prior listen, absence gap, return
  intensity, persistence, related era, and rediscovery class.
- Distinguish one-off returns, sustained rediscoveries, and returns that begin a new era, while
  acknowledging source gaps that may resemble absences.
- Present dormancy as a bounded, reversible, as-of observation with confidence components,
  observation window, and right-censoring warnings; never state abandonment as permanent fact.
- Make later rediscovery visibly supersede an older dormancy conclusion when both approved
  snapshots or narrative records are represented.
- Use editorial selection to keep the experience story-led; provide a bounded analytical explorer
  only over the public eligible cohort.

**Acceptance:** wording and interactions do not overclaim absence or abandonment, every story and
classification exposes its approved evidence/parameters, later observations supersede rather than
silently rewrite prior conclusions, and selected track names cannot enter through unreviewed data.

### P6-09 — Add or explicitly defer the experimental genre lab

**Depends on:** Phase 5 gate, P6-02, and P6-05

**Work:**

- Reconfirm the Phase 5 fitness assessment against the snapshot intended for publication.
- If included, isolate genre views behind an explicit experimental treatment showing raw mode,
  MusicBrainz provider, nullable taxonomy, artist-level weighting, freshness, and usable-event
  coverage overall and across time.
- Explain that provider tags can be sparse, current rather than historically contemporaneous, and
  unrepresentative of the complete history.
- If the treatment cannot communicate the limitations without misleading visitors, defer the route
  and record the evidence and product gate required to activate it later.

**Acceptance:** either no genre route/data ships and the deferral is documented, or every genre
view is unmistakably experimental and displays provider, mode, taxonomy, weighting, freshness, and
coverage. Partial enrichment is never plotted as complete history.

### P6-10 — Implement reviewed publication and GitHub Pages deployment

**Depends on:** P6-04 through P6-09 as applicable

**Work:**

- Add explicit commands for generating a candidate snapshot, validating/reviewing it, approving it
  for publication, building the production site from the approved snapshot, and verifying the
  deployed artifact. Preserve concise human output plus structured summaries where automation is
  appropriate.
- Add a GitHub Actions workflow that installs the pinned toolchain, runs the applicable quality and
  site gates, builds only from committed approved public data, uploads the static Pages artifact,
  and deploys through the protected `github-pages` environment.
- Configure the canonical custom domain `music.the816.com`, HTTPS, base/canonical URL behavior,
  cacheable hashed assets, and safe rollback to a prior deployment.
- Ensure normal pushes redeploy the last approved snapshot but cannot regenerate or approve new
  private-derived data. Document the manual snapshot release cadence and responsibilities.
- Document local preview, approval, deployment, DNS/domain setup, rollback, troubleshooting, and
  publication cautions.

**Acceptance:** a fresh checkout containing only committed project files and an approved public
snapshot can reproduce the exact static site; fixture/PR builds cannot publish; only the protected
deployment job can update Pages; the custom domain serves the intended artifact over HTTPS; and a
prior approved snapshot/deployment can be restored without private inputs.

### P6-11 — Complete end-to-end, accessibility, privacy, content, and performance verification

**Depends on:** P6-01 through P6-10

**Work:**

- Test the deterministic fixture path from a rebuilt fixture database through private analytics,
  public projection, static build, and rendered journeys.
- Verify a manually approved archive snapshot locally using only aggregate and allowlisted
  publication findings; do not commit or log private source or private analytical content.
- Add critical browser journeys, direct/deep-link checks, JavaScript-disabled checks, keyboard and
  screen-reader-oriented assertions, automated accessibility checks, and stable visual regression.
- Enforce representative budgets for generated pages, JavaScript, data payloads, chart rendering,
  and initial/deferred loading. Lazy-load or shard bounded explorer data where evidence shows it is
  necessary.
- Audit the built artifact, source maps, manifests, network requests, console output, errors,
  metadata, downloads, and repository history for forbidden or unapproved data and secrets.
- Review narrative claims, analytical totals, links, responsive layouts, reduced motion, social
  metadata, methodology, privacy notice, version/as-of disclosure, and genre experimental status.
- Run a production smoke test for `music.the816.com` after deployment without adding visitor
  tracking unless P6-02 explicitly approved it.

**Acceptance:** fixture totals reconcile from database to rendered views; all applicable quality,
accessibility, privacy, content, and performance gates pass; no private input, private bundle,
secret, or unapproved field is shipped; the deployed site communicates limitations honestly; and
the approved snapshot, site artifact, and deployment are reproducible and rollback-safe.

## Phase gate

Phase 6 is complete when `music.the816.com` presents a compelling, accessible narrative and
explorer over an explicitly approved public snapshot; communicates source coverage, metric scope,
parameters, uncertainty, genre limitations, and as-of/publication dates honestly; contains no
unapproved private data; and can be regenerated, reviewed, deployed, and rolled back reproducibly
without a hosted database or knowledge of raw Spotify or Last.fm formats.
