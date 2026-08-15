# Phase 6 static web and visualization stack

**Task:** P6-03  
**Status:** accepted for the initial microsite  
**Decision date:** 2026-08-09

## Context and dependency finding

P6-01 and P6-02 are complete and agree with the implemented state. The product specification
requires a narrative-first site whose default views, summaries, tables, navigation, and
methodology work without JavaScript. The publication contract supplies bounded, closed public
artifacts and forbids the site from reading private analytical exports, SQLite, source tables, or
individual listening events. It also permits no runtime third-party request, visitor account,
telemetry, or downloadable data file in version 1.

Those constraints favor a static multi-page site with small opt-in islands over a client-rendered
application. The approved snapshot is finite: at most 600 history months, 200 eligible artists, 40
stories, and the other P6-02 result limits. No route needs a runtime query to render its default
state. There is therefore no demonstrated deployment or ownership boundary that would justify a
server runtime, hosted database, or second package.

## Decision summary

| Concern | Initial strategy |
| --- | --- |
| Build and runtime | Astro static output, strict TypeScript, ECMAScript modules, Node.js 24, and pnpm 9 in the existing single package |
| Data loading | One project-owned, build-time public-snapshot adapter reads and validates only the active approved snapshot; pages and islands receive page-scoped view models |
| Charting | Observable Plot behind a project-owned chart adapter for analytical charts; every chart has an adjacent summary and equivalent table |
| Interaction | Preact islands only for bounded filters, chart controls, and URL state; Astro renders the useful default state first |
| Styling | Project-owned CSS tokens, cascade layers, global foundations, and component-scoped styles using the system font stack |
| Testing | Existing Node tests for pipeline contracts; Vitest for site units, Preact Testing Library for islands, and Playwright for built-site browser tests |
| Accessibility | WCAG 2.2 AA baseline, semantic static HTML, automated axe and accessibility-tree checks, keyboard/reduced-motion tests, and manual assistive-technology review |
| Publication | GitHub Pages deploys `site/dist/` from a committed approved snapshot through a protected action; `music.the816.com` is the configured `site` with no `base` path |

This task records the choices and compatibility evidence. It deliberately adds no site dependency,
command, route, workflow, or generated artifact. P6-04 implements the snapshot pipeline; P6-05
adds the exact-pinned site dependencies and shell. P6-10 implements deployment.

## Compatibility verification

The repository pins Node.js `24.15.0` and pnpm `9.0.0` through Volta, constrains their major
versions in `package.json`, uses ECMAScript modules, and currently uses TypeScript `7.0.2`. The
following candidate set was checked before any repository dependency was added:

| Package | Version checked | Declared compatibility relevant to this project |
| --- | ---: | --- |
| `astro` | 7.2.0 | Node `>=22.12.0`, pnpm `>=7.1.0` |
| `@astrojs/preact` | 6.0.2 | Node `>=22.12.0`, Preact `^10.6.5` |
| `preact` | 10.29.8 | Satisfies the integration peer range |
| `@observablehq/plot` | 0.6.17 | Node `>=12` for the package toolchain; browser output is ESM-compatible |
| `vitest` | 4.1.10 | Node `^20`, `^22`, or `>=24` |
| `@testing-library/preact` | 3.2.4 | Preact `>=10` |
| `jsdom` | 30.0.1 | Includes Node `^24.15.0` |
| `@playwright/test` | 1.62.1 | Node `>=20` |
| `@axe-core/playwright` | 4.12.1 | Compatible with `playwright-core >=1` |

A disposable synthetic probe used Node `24.15.0`, pnpm `9.0.0`, strict peer-dependency
resolution, the repository's TypeScript `7.0.2`, Astro static output, one Preact
`client:visible` island, and an Observable Plot chart with explicit ARIA text. Installation,
`astro build`, and `tsc --noEmit` passed. The output was one static `index.html` plus hashed client
assets, retained meaningful static copy and a data table, and required no server adapter. The
probe's complete chart-island JavaScript was about 90 KiB gzip, which informed the budget below.
The probe used one deterministic synthetic row and no project database, private input, private
bundle, environment secret, or network request at build/runtime.

These versions are compatibility evidence, not floating ranges or an instruction to use `latest`.
When P6-05 adds the site, it must re-read package metadata, exact-pin a mutually compatible set
under the repository's `save-exact=true` policy, update the one root lockfile, and repeat the static
fixture build under the pinned toolchain. A major-version change requires the same check.

`@astrojs/check` 0.9.10 is not selected for version 1 because its published peer range stops at
TypeScript 6 while this repository uses TypeScript 7. The project will not suppress that peer
conflict or downgrade the repository compiler. Astro documents that `astro build` transpiles but
does not type-check `.astro` files, and `tsc` ignores those files.

**P6-05 amendment (2026-08-15):** the earlier prohibition on adding `.astro` source without a
compatible `astro check` release is removed so the static shell is not indefinitely coupled to an
upstream peer-range update. Until an exact-pinned checker officially supports the repository's
TypeScript version, the required local gate is strict `tsc` over all site `.ts`/`.tsx` logic,
deterministic adapter and view-model tests, an Astro production build, and built-HTML assertions for
every route template and shared accessibility/privacy contract. Astro components remain thin:
boundary validation, state parsing, disclosure shaping, and other behavioral logic belong in typed
modules rather than frontmatter. Adding a compatible `astro check` command remains a future
toolchain improvement, not a prerequisite for P6-05 completion.

This accepts a narrow diagnostic gap for template-only expressions. The alternatives were to wait
for an unspecified checker release, suppress an unsupported peer dependency, or downgrade the
repository compiler; all were rejected because they either block the planned site or weaken the
established package/toolchain contract more broadly. Production builds and built-output tests do
not become general substitutes for type checking; they are the scoped fallback only for `.astro`
templates while the supported checker is unavailable.

References used for the decision:

- [Astro TypeScript and type-checking guidance](https://docs.astro.build/en/guides/typescript/)
- [Astro Preact integration](https://docs.astro.build/en/guides/integrations-guide/preact/)
- [Astro client hydration directives](https://docs.astro.build/en/reference/directives-reference/)
- [Astro testing guidance](https://docs.astro.build/en/guides/testing/)
- [Astro GitHub Pages deployment guidance](https://docs.astro.build/en/guides/deploy/github/)
- [Observable Plot accessibility options](https://observablehq.com/plot/features/accessibility)
- [Playwright browser projects](https://playwright.dev/docs/browsers)
- [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing)

## Static build and GitHub Pages strategy

The site will live under `site/` but remains part of the root pnpm package. It has no nested
`package.json`, workspace file, independent lockfile, or separately versioned internal package.
Root scripts added by P6-05 will own development, type checking, tests, and build commands.

Astro configuration will make the deployment contract explicit:

- `output: "static"`; no server, hybrid, or on-demand route and no deployment adapter;
- `outDir` resolves to `site/dist/`, separate from the current TypeScript `dist/` output;
- `site: "https://music.the816.com"`, no `base`, because the custom domain serves the root;
- `trailingSlash: "always"`, matching the P6-01 canonical route forms and directory output;
- every dynamic artist and story path comes from approved slugs through `getStaticPaths()`;
- unknown, withdrawn, and ineligible slugs all use the same static not-found behavior; and
- production builds fail closed when the active approved pointer, manifest, artifact hashes,
  schema versions, or cross-artifact references are invalid.

P6-10 will use GitHub Actions with the pinned Node/pnpm setup, a frozen root lockfile, the applicable
quality gates, and a build from committed approved data only. It will upload `site/dist/` as the
Pages artifact and deploy only from the protected `github-pages` environment. The custom-domain
`CNAME`, DNS, HTTPS, action permissions, approval protection, and rollback workflow belong to
P6-10. Pull requests and fixture builds may build and inspect the artifact but cannot deploy it.

No GitHub Pages action may generate or approve a public snapshot. A normal deployment rebuilds the
site from the already committed active snapshot and can roll back by selecting a prior committed
approved snapshot without private inputs.

## Data-loading and trust boundaries

The public snapshot is an external boundary even though its approved bytes are committed. Static
typing alone is not trusted. The site adapter parses the active pointer, manifest, and every needed
artifact through the closed P6-02 validators, checks hashes and cross-references, and returns only
project-owned public types. It reads at build time only. It cannot import database adapters,
analytical-export readers, source-table types, environment credentials, or code under an importer,
synchronizer, reconciliation, or enrichment boundary.

```text
private bundle + reviewed editorial inputs
  -> P6-04 public projection and explicit approval
  -> active committed public snapshot
  -> build-only public-snapshot adapter
  -> pure route view models
  -> Astro static HTML and page-scoped Preact props
  -> GitHub Pages files
```

The approved JSON files are build inputs, not files copied wholesale into the deployed output.
Pages embed only the fields needed by their HTML and, where an island is present, the smallest
bounded page-scoped view model required for that interaction. There is no browser `fetch()` to a
private or public API, no general snapshot download endpoint, and no client-side escape hatch to
the suppressed artist tail. The default HTML summary and table are rendered from the same view
model as the chart so their totals and qualifications cannot drift.

## Project-owned code boundaries

P6-05 may refine names while preserving these responsibilities:

| Boundary | Responsibility | Must not do |
| --- | --- | --- |
| `src/publication/` | P6-04 private-to-public projection, approval contracts, and closed validators | Render pages or become browser code |
| `data/publication/` | Immutable approved snapshots plus the small active pointer | Contain candidates, private bundles, database files, or unapproved content |
| `site/src/adapters/` | Build-only snapshot discovery, validation, hash checks, and public typed reads | Import SQLite/source adapters or pass raw files directly to pages |
| `site/src/view-models/` | Pure deterministic shaping, sorting, summaries, disclosure text, table rows, and page-scoped chart data | Perform I/O, mutate snapshot data, or infer undisclosed facts |
| `site/src/components/` | Static Astro layouts, narrative sections, disclosures, tables, and empty/error states | Own private-data access or application-wide client state |
| `site/src/islands/` | Small Preact controls for a bounded public view and allowlisted URL state | Become a router, fetch unbounded data, or render the only meaningful content |
| `site/src/charts/` | Observable Plot options/adapters and the exceptional project-owned SVG renderer | Accept private contracts or omit the shared textual/table equivalent |
| `site/src/content/` | Site-owned navigation, route copy, methodology scaffolding, and privacy disclosure | Duplicate story/entity facts or bypass the P6-02 editorial approval contract |
| `site/src/styles/` | Tokens, resets/foundations, utilities with documented semantics, and shared print/motion rules | Load a remote font, tracker, or runtime stylesheet |
| `site/src/pages/` | Static route composition, metadata, canonical URLs, and approved `getStaticPaths()` lists | Query SQLite, source tables, private bundles, or a hosted service |

Authored annotations, featured artists, selected tracks, and stories enter through P6-04 and the
approved `editorial.json`/`stories.json` artifacts. Version 1 does not add MDX or an Astro content
collection as a parallel publication channel. Generic site copy may be committed under
`site/src/content/` only when it contains no private entity detail and no fact that the approved
snapshot is supposed to authorize.

## Interaction and progressive enhancement

Astro owns document structure and all non-interactive rendering. Preact is used only when a control
needs durable client state: bounded range/grain selection, eligible-artist comparison, chart/table
switching, or canonical URL updates. There is no SPA router, global client store, React compatibility
layer, or `client:only` component in version 1.

Every island receives a closed, immutable view model and treats query parameters as untrusted input.
It accepts only documented keys and values, falls back visibly to the build-time default, and cannot
broaden the embedded cohort. Normal links and forms preserve meaningful navigation. The default
summary and table remain in the document if hydration fails or JavaScript is disabled.

Hydration is chosen per island: `client:visible` for chart explorers below the fold,
`client:idle` for lower-cost controls that should become ready soon after load, and `client:load`
only when an above-the-fold control has a tested need for immediate interaction. Reduced-motion
preference disables nonessential transitions; interaction never depends on animation.

Preact was selected over React because the required state is local and its compatibility layer is
not needed. Vanilla JavaScript remains appropriate for a truly one-line enhancement, but bespoke
DOM state machines are not the default for filters that need typed state, tests, and rerendering.

## Charting and SVG boundary

Observable Plot is the default analytical grammar. It maps the project's tabular aggregate view
models to composable marks and scales without introducing an application framework. A
project-owned wrapper owns dimensions, responsive re-rendering, color tokens, tick and value
formatting, metric labels, captions, `ariaLabel`, `ariaDescription`, and whether redundant marks
are hidden from the accessibility tree. Page and component code do not call Plot directly.

Plot's generated ARIA is useful but is not treated as the complete accessible experience. Each
figure has a visible heading/caption, a concise prose finding, source/coverage/parameter disclosure,
and an equivalent HTML table generated from the same view model. Color, geometry, ordering,
hover, and position never carry a distinction alone. Pointer tips are supplemental; the underlying
value must be available by keyboard or in the table.

Project-owned SVG is an exception only for the artist-era composition if a fixture demonstrates
that Plot cannot express the overlapping interval layout, labels, and focus behavior within the
budgets. The exception must remain behind `site/src/charts/`, accept the same public view model, use
semantic title/description and explicit text labels, expose no pointer-only interaction, and retain
the same prose/table alternative. It may not become a general charting system or be activated only
for visual novelty.

Plot was selected over direct D3 because the initial charts need standard composable marks more
than low-level DOM control. Vega-Lite would add another grammar and runtime for limited benefit,
while large dashboard chart suites bring controls and semantics that fight the narrative and
bundle budgets. Direct SVG remains available only at the documented exception boundary.

## Styling strategy

Version 1 uses authored CSS rather than a utility framework or CSS-in-JS runtime. A small global
foundation defines cascade layers, spacing/type/color/motion custom properties, document defaults,
focus treatment, visually hidden text, and print rules. Astro component styles are scoped by
default; shared semantic utilities remain few and documented. Preact islands use the same token
classes and do not ship a styling runtime.

The system font stack fulfills P6-02's no-font-request policy. Theme tokens are tested for WCAG 2.2
AA contrast in their actual combinations. Layout works at 320 CSS pixels and 200% zoom without
two-dimensional page scrolling. Container/media queries enhance layouts only when the supported
browser policy permits them, with a readable single-column fallback. Motion is optional and
suppressed under `prefers-reduced-motion: reduce`.

Tailwind and component suites were rejected for the initial publication because the route set is
small, the visual language should be project-owned, and neither solves the analytical disclosure
or accessibility requirements. CSS-in-JS was rejected because it adds hydrated runtime work to a
mostly static site.

## Test strategy

Testing is layered around the trust boundaries:

1. The existing Node test runner continues to cover pipeline/publication contracts and P6-04
   projection behavior with deterministic synthetic fixtures.
2. Vitest covers pure site adapters and view models, including closed-schema rejection, missing or
   inconsistent approved data, deterministic sorting/summaries, URL parsing, empty states, metric
   separation, and chart/table total parity.
3. Preact Testing Library with jsdom covers island behavior through roles and accessible names:
   keyboard changes, invalid URL fallback, bounded filtering, focus retention, reduced motion, and
   chart/table switching. Tests do not assert framework implementation details.
4. Astro components are kept thin and exercised through their production-built HTML. Playwright
   covers all critical routes, approved dynamic paths, same not-found behavior, direct/deep links,
   JavaScript-disabled reading, keyboard-only journeys, responsive layouts, print/table access,
   and same-origin/no-unexpected-request behavior.
5. Contract fixtures reconcile database-to-private-analysis-to-public-view-model totals in P6-11.
   Private archive records never become fixtures, snapshots, screenshots, or CI output.

Once the site exists, the normal quality gate includes formatting, linting, strict `tsc` for site
`.ts`/`.tsx`, site unit/component tests, Astro's production build, built-HTML assertions for every
route template, and built-artifact privacy and byte-budget checks. Add an exact-pinned `astro check`
diagnostic when its published TypeScript peer range includes the repository compiler. Browser
binaries are separately pinned by Playwright; the critical browser suite is required in CI for site
changes and before publication rather than silently skipped when a developer has no local browser
installed.

## Accessibility automation and manual review

Automated accessibility checks use `@axe-core/playwright` against every route template and every
material interactive/empty/error state in Chromium. Playwright role assertions and focused ARIA
snapshots verify landmarks, headings, names, descriptions, table structure, disclosures, and focus
state. Browser tests also cover 200% zoom, 320 CSS pixels, keyboard-only operation,
`prefers-reduced-motion: reduce`, and JavaScript disabled.

Automation is not acceptance by itself. Before a public release, manual review covers document
order, chart/table equivalence, visible focus, zoom/reflow, contrast, motion, high-contrast/forced
colors where available, VoiceOver with Safari on macOS/iOS, and NVDA with Firefox or Chrome on
Windows. Any finding that blocks understanding or operation fails the release even when axe is
clean.

## Visual-regression scope

Playwright screenshot baselines use only deterministic public fixtures and a pinned Linux Chromium
environment. They cover the route shell, long-view chart and table, overlapping artist-era state,
one story evidence block, the shared disclosure system, not-found, and representative empty state
at 320, 768, and 1440 CSS-pixel widths. A reduced-motion capture is included for a hydrated route.

Firefox, WebKit, native system-font rasterization, and authored copy are checked functionally rather
than through cross-platform pixel baselines. Visual snapshots mask no analytical value and are
updated only with an intentional reviewed UI change. P6-05 establishes the first shell baselines;
P6-06 through P6-09 add only the route-specific stable states they introduce; P6-11 performs the
final production-artifact pass.

## Performance budgets

Budgets are measured on production output with the deterministic public fixture:

- a route with no island ships **0 KiB of route-authored client JavaScript**;
- an interactive route ships at most **125 KiB gzip of initial client JavaScript**, including
  Astro, Preact, Plot, and the route island;
- page-scoped serialized public data is at most **75 KiB gzip** per route;
- each generated HTML document is at most **150 KiB uncompressed**;
- the initial HTML + CSS + JavaScript + serialized-data transfer for a route is at most **250 KiB
  gzip**, excluding explicitly user-requested navigation;
- below-the-fold charts hydrate with `client:visible`; a route must not eagerly load data for
  another route or the suppressed public tail;
- production pages make **zero automatic third-party requests** and no source map is deployed; and
- lab checks target LCP at or below 2.5 seconds, CLS at or below 0.1, and INP at or below 200
  milliseconds under the documented mobile profile. There is no production RUM because visitor
  analytics are prohibited.

The byte gates are hard build failures. Lab timing is a release gate measured repeatedly, not a
claim based on localhost once. If a route exceeds a budget, first reduce marks/props, split or defer
the island, and shard the already approved public view by static route. A hosted query service is
not the fallback.

## Supported-browser policy

Full interaction supports the current and previous stable major releases, at release time, of
Chrome, Edge, Firefox, and Safari on macOS, plus the corresponding current and previous iOS Safari
releases. The static narrative, navigation, disclosures, summaries, and tables remain usable with
JavaScript disabled. Internet Explorer and browsers without modern ECMAScript modules are not in
the interactive support matrix.

Playwright runs pinned Chromium, Firefox, and WebKit projects for the critical journeys, with
desktop and representative mobile viewports. Chromium runs on each site pull request; all three
engines run before publication. Stable Chrome/Edge and real Safari/iOS checks are manual release
coverage where bundled engines cannot prove the vendor-specific result. A browser regression is
not dismissed merely because the static fallback still works.

## Alternatives and rationale

| Alternative | Decision against required criteria |
| --- | --- |
| Next.js or another server-oriented React framework | Can emit static pages, but defaults and ecosystem pressure add a larger client/server model than the bounded publication needs. It weakens the explicit no-runtime boundary and does not improve public-snapshot compatibility. |
| Eleventy or a hand-built Vite site | Strong static output and low runtime cost, but Astro provides first-class strict TypeScript authoring, file routes, static path generation, scoped CSS, and selective Preact hydration with less project-owned build plumbing. |
| A Preact single-page application | Testable and typed, but delays meaningful content until JavaScript, increases routing/state/bundle maintenance, and makes the no-JavaScript and indexable narrative requirements harder. |
| React islands | Mature testing and composition, but unnecessary compatibility/runtime weight for bounded local state. Preact satisfies the same interaction boundary with a smaller client. |
| Vanilla JavaScript for every explorer | Lowest library floor for tiny controls, but repeated typed filter/URL/chart state would become bespoke DOM infrastructure with poorer component testability. It remains allowed for trivial enhancements. |
| Direct D3 or project-owned SVG for every chart | Maximum composition control, but significantly more maintenance and accessibility work. Plot covers the standard aggregate charts; SVG is retained only for the evidence-backed era exception. |
| Vega-Lite or a dashboard chart suite | Declarative or feature-rich, but adds grammar/runtime cost and generic dashboard behavior without improving the narrative, table, or privacy contracts. |
| Tailwind, a component suite, or CSS-in-JS | Faster generic composition in some products, but adds configuration/runtime or generated vocabulary while the small site needs distinctive project-owned styles, static CSS, predictable focus/motion rules, and no third-party assets. |
| Astro live content loaders, SSR, or a hosted database/API | Designed for request-time freshness and query scale that the approved immutable snapshot does not need. They would add credentials, failure modes, privacy review surface, and rollback complexity. |
| A workspace/monorepo split for `site/` | Adds versioning, scripts, dependency graph, and duplicate configuration without an independent owner, release cadence, runtime, or reusable package. Root code and site share the public contract and one release gate. |

Across static output, TypeScript integration, progressive enhancement, bundle cost, chart
composition, accessibility, maintenance, testability, and public-snapshot compatibility, the chosen
stack is the smallest coherent fit. Astro owns static documents, Preact owns only bounded client
state, Plot owns standard chart composition behind an adapter, and project code owns every privacy,
view-model, disclosure, style, and exceptional-SVG decision.

## Consequences and change gates

- The site can be reproduced from a fresh checkout plus the committed approved snapshot without a
  database, private bundle, secret, network provider, server runtime, or knowledge of source formats.
- Most components and every default route remain static. Interaction is additive and has an explicit
  cost visible in the built artifact.
- Public contract changes remain in `src/publication/`; chart or framework churn is isolated behind
  site adapters and view models.
- No schema or migration changes are required by this decision.
- Adding a server adapter, hosted database/API, SPA router, second package, remote asset/request,
  analytics, general custom-SVG system, or client access to whole snapshot files is a new decision,
  not an implementation convenience.
- P6-04 and P6-05 must preserve these boundaries. Evidence that the finite approved snapshot cannot
  meet a named route or budget should trigger a plan/decision update rather than silent scope growth.
