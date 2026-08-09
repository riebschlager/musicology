# Public microsite product specification

**Task:** P6-01  
**Status:** approved product direction for the remaining Phase 6 tasks  
**Audience:** public visitors, including people who do not know the archive, its source formats, or
the analytical pipeline

## Scope and dependency decision

This specification defines the first public narrative, route hierarchy, journey behavior,
editorial model, and experience baseline. It does not authorize any field for publication, choose
the final public date granularity or artist threshold, select the web stack, or build a site. Those
decisions remain with P6-02 and P6-03.

P6-01's dependencies are satisfied:

- Phase 4 supplies stable `analytical-result-v2` results and the private
  `analytical-export-v2` bundle for volume, artist eras, rediscovery, abandonment, and coverage.
- Phase 4 archive validation records the early sparse evidence, the 2017–2024 Last.fm source gap,
  overlap behavior, partial Spotify duration coverage, and the right-censored recent edge.
- Phase 5 supplies `genre-eras.json`, but its fitness assessment is **experimental; not fit for an
  unqualified user-facing genre-era view**. The genre lab is therefore conditional and outside the
  first-release core until P6-09 repeats the activation check.

The plan and implemented state agree. No route below needs a new private analytical query to define
its first-release default. P6-02 may narrow what is publishable, and P6-04 must project the listed
private contracts into approved public view models before any site consumes them.

## Audience and narrative promise

The primary visitor is a curious reader: a friend, music fan, or fellow data-minded listener who
wants to understand how one person's musical life changed over more than twenty years. A secondary
visitor wants to inspect an artist, time range, or analytical definition after reading the story.
Neither visitor should need to understand Spotify exports, Last.fm scrobbles, reconciliation, or
SQLite before the page makes sense.

The promise is **a long-form personal music history with an analytical explorer**. It reads like a
listening atlas with liner notes: an authored argument supported by inspectable evidence, not an
internal dashboard and not a generic streaming recap. It treats gaps and uncertainty as part of
the story. It does not present rankings as identity, inferred eras as permanent labels, dormancy as
fate, or partial duration and genre evidence as complete history.

The editorial voice is first-person, specific, reflective, and modest about inference. Analytical
copy distinguishes an observation (what the approved aggregate shows) from a memory or
interpretation (what the author believes it meant).

## First-release narrative

The release opens with one continuous argument on `/`:

1. **The record begins before it becomes complete.** Introduce the retained history and explain
   that the earliest evidence comes from Last.fm alone and is sparse in places.
2. **Listening has a long shape, not one winning year.** Show the canonical play-count arc with
   source coverage in the same reading sequence. Explain why Spotify-backed listened time is a
   different, partial metric; it is not a first-release control unless a later versioned private
   artifact supplies it and P6-02 permits its publication.
3. **Artists arrive in overlapping seasons.** Use selected artist-era intervals as parameterized
   signals, with component evidence and links to eligible artist pages.
4. **Music leaves and comes back.** Pair curated rediscovery and dormancy stories. Source gaps,
   open persistence windows, observation periods, and later supersession stay visible.
5. **The ending is still being observed.** Close on the right-censored recent edge, the as-of date,
   and invitations to explore the bounded public data or read the methodology.

The long-form overview is the canonical entry point. `/history/`, `/artists/`, `/stories/`, and
`/explore/` deepen it; `/methodology/` substantiates it. The conditional genre lab never interrupts
this core narrative or appears as complete history.

## Information hierarchy

The persistent primary navigation is **Long view**, **History & coverage**, **Artists**,
**Stories**, **Explore**, and **Methodology**. On small screens it may collapse visually, but all
destinations remain in one labeled navigation landmark and in document order.

```text
/
├── /history/
├── /artists/
│   └── /artists/[artistSlug]/
├── /stories/
│   └── /stories/[storySlug]/
├── /explore/
├── /methodology/
└── /lab/genres/             conditional; activate or omit as a whole
```

Every page follows the same reading hierarchy:

1. a plain-language question and authored answer;
2. an accessible summary of the principal finding;
3. the visual or editorial evidence;
4. coverage, metric, parameter, timezone, version, and as-of disclosures adjacent to that evidence;
5. a data table or structured text alternative;
6. bounded next steps, share state, and methodology links.

## Shared journey rules

- A **default view** is fully determined at build time from the approved public snapshot and
  authored public content. It must render meaningful HTML before optional JavaScript runs.
- A **filter** selects only fields and rows already present in a bounded public artifact. It cannot
  issue a database, API, or hosted-service query. Unsupported URL values fall back to the documented
  default with a visible explanation; they never broaden the dataset.
- **URL-addressable state** uses allowlisted query keys and approved public slugs. The canonical URL
  omits default values. P6-02 owns the public date representation, entity eligibility, and result
  limits, so this document names state semantically without authorizing exact values or cardinality.
- A **drill-down** can reach only a statically generated eligible route or another bounded public
  view. There is no route for an ineligible long-tail artist, an individual event, or arbitrary
  track history.
- Every analytical view repeats its metric definition, sources, coverage, unresolved proportion,
  parameters, timezone, analytical versions, and as-of date from the approved public projection.
  Duration remains visibly Spotify-only. Genre additionally shows provider, mode, nullable
  taxonomy, artist-level weighting, freshness, and usable-event coverage.
- A **table alternative** is equivalent in scope to its chart and remains available without
  JavaScript. It contains only public fields and follows the same ordering and filters.
- **Share** means a canonical page URL containing only allowlisted route state. A copy control is a
  convenience, not the only way to obtain the link.
- **Export** means a prebuilt, view-level download explicitly authorized by P6-02. There is no
  client-generated whole-snapshot export, private-bundle download, event log, or unbounded query.
  When downloads are not authorized, the journey offers only its share URL and printable table.

## Route and journey register

Each route section contains the same required fields so later design, snapshot, and browser tests
can trace a page back to its inputs and fallback behavior.

### Route: `/`

- **Question:** What is the long shape of this listening life, and how trustworthy is each part of
  the record?
- **Narrative role:** Primary long-form overview and first-release thesis; it connects the history,
  artist, return, dormancy, and methodology journeys without becoming a dashboard.
- **Default view:** Authored five-act narrative with a full-history canonical monthly play-count
  arc, aligned coverage context, selected artist-era callouts, and curated story excerpts.
- **Filters:** No global dashboard filters. A progressive time-grain control may switch the long
  view among approved year, quarter, or month aggregates; the authored sequence remains fixed.
- **URL-addressable state:** `grain=<grain>` and `view=chart|table`; defaults are omitted.
- **Drill-down:** History sections link to `/history/`; eligible artist annotations link to their
  static artist route; curated excerpts link to their static story route; evidence links to
  `/methodology/`.
- **Supporting input:** `volume.json`, `coverage.json`, selected intervals from
  `artist-eras.json`, explicitly selected records from `rediscovery.json` and `abandonment.json`,
  plus overview annotations and story excerpts from authored public content.
- **Uncertainty disclosure:** Early Last.fm-only evidence, sparse periods, the 2017–2024 Last.fm
  gap, overlap/reconciliation, Spotify-only duration coverage, unresolved rate, and the
  right-censored recent edge are disclosed in context rather than only in a footer.
- **Empty state:** If public history is empty, render an authored explanation that no reviewed
  history is available, omit quantitative claims, and retain methodology and privacy links.
- **Tabular alternative:** A period-by-period long-view table pairs the displayed canonical metric
  with approved coverage indicators and authored annotation labels.
- **Bounded export/share action:** Share the canonical overview state; offer only an approved
  long-view table download if P6-02 authorizes it.

### Route: `/history/`

- **Question:** Where does the evidence come from, where is it thin or missing, and which metrics
  can be compared across the full span?
- **Narrative role:** Make the record's construction and limitations legible before visitors infer
  behavior from changes in volume.
- **Default view:** Canonical yearly play count aligned with source-specific yearly evidence,
  observed ranges, long gaps, source backing, overlap, unresolved proportion, and Spotify-duration
  availability.
- **Filters:** Approved date range and `grain=year|quarter|month`, regrouped from the stable monthly
  `play_count` rows. Source is a coverage overlay, not an alternate full-history metric. Duration
  and thresholded metrics need a new versioned private artifact before they can become controls.
- **URL-addressable state:** `from=<period>`, `to=<period>`, `grain=<grain>`, and
  `view=chart|table`.
- **Drill-down:** A selected period moves to `/explore/` with the same approved range and grain;
  disclosure links explain reconciliation, metric scope, and source gaps in `/methodology/`.
- **Supporting input:** `volume.json` for canonical metrics and `coverage.json` for aggregate source
  evidence, source ranges, gaps, overlap, duplicate handling, and unresolved coverage.
- **Uncertainty disclosure:** A source-evidence count is not a canonical play count; both-source
  events are reconciled once; Spotify duration is partial; a source gap is not an absence of
  listening; the recent edge is incomplete.
- **Empty state:** Render the coverage schema and explanation with zero/unknown values, never an
  invented zero-history timeline.
- **Tabular alternative:** Separate but aligned canonical-volume and source-coverage tables, each
  with its denominator and metric definition in the caption.
- **Bounded export/share action:** Share the bounded URL; expose only separately labeled approved
  volume and coverage tables, never a joined event-level download.

### Route: `/artists/`

- **Question:** Which eligible artists shaped particular periods, and how did their signals overlap?
- **Narrative role:** Move from the overall arc to explainable, parameterized artist-era intervals
  without implying permanent favorites or an exhaustive public artist catalog.
- **Default view:** A bounded chronological set of eligible artist intervals, ordered by time and
  showing peak, strength, play count, share, and overlapping intervals.
- **Filters:** Approved range and bounded eligible-artist search/selection. Exact custom threshold
  editing and alternate presets require a new versioned analytical input and are not first-release
  controls.
- **URL-addressable state:** `from=<period>`, `to=<period>`, repeated `artist=<publicSlug>`,
  and `view=timeline|table`.
- **Drill-down:** Selecting an admitted interval opens `/artists/[artistSlug]/`; ineligible artists
  cannot be requested by ID or discovered through search payloads.
- **Supporting input:** `artist-eras.json`, projected through the P6-02 eligibility and result-limit
  rules; featured-artist labels and contextual annotations come from authored public content.
- **Uncertainty disclosure:** Era intervals are signals under displayed parameters; strength is
  composed from window activity, rolling activity, share, rank, consecutive activity, and baseline
  change; sparse and overlapping intervals remain qualified.
- **Empty state:** Explain that no eligible interval matches the current approved filters and offer
  a reset to the default public cohort without revealing excluded names or counts.
- **Tabular alternative:** One row per public interval with public artist name, bounds, peak,
  strength, play count, share, and a link to component evidence.
- **Bounded export/share action:** Share only approved slugs and range state; a download, if allowed,
  contains only the currently displayed eligible intervals.

### Route: `/artists/[artistSlug]/`

- **Question:** What made this selected artist important in the retained history, and when was that
  importance most visible?
- **Narrative role:** Combine an eligible artist's public analytical context with clearly separate
  authored interpretation and manually selected track stories.
- **Default view:** Artist introduction, qualifying intervals, peak and component summary,
  public period summaries derived from interval evidence, authored context, and links to approved
  related stories.
- **Filters:** Approved date range and `view=summary|components|table`; the route cannot expand to
  arbitrary tracks or individual plays.
- **URL-addressable state:** The admitted `artistSlug`, `from=<period>`, `to=<period>`, and
  `view=<view>`.
- **Drill-down:** Component rows return to the matching artist-era state; selected story references
  open only static `/stories/[storySlug]/` pages.
- **Supporting input:** The eligible artist's intervals and component evidence from
  `artist-eras.json`, an authored featured-artist entry, and separately approved story references.
  No full artist event series is required for the first-release default.
- **Uncertainty disclosure:** Eligibility is a publication rule, not an importance verdict; interval
  bounds and strength depend on public parameters; missing baseline, sparse windows, unresolved
  events, and source coverage are stated.
- **Empty state:** An unknown or ineligible slug returns the static not-found experience without
  confirming private catalog membership. An eligible artist with no current story still gets the
  analytical summary and a plain “no featured story” message.
- **Tabular alternative:** Interval and component tables contain only the selected eligible artist's
  approved aggregate fields.
- **Bounded export/share action:** Share the static public slug and approved view state; export only
  that artist's approved interval table if downloads are authorized.

### Route: `/stories/`

- **Question:** Which returns and disappearances best illuminate the larger listening history?
- **Narrative role:** A curated reading path that treats analytical candidates as prompts for
  personal narrative, not as an automatically ranked feed.
- **Default view:** Authored sequence interleaving selected rediscovery and dormancy cards, each
  labeled as analytical evidence plus editorial interpretation.
- **Filters:** `kind=all|rediscovery|dormancy` and an approved coarse period; no free-form entity or
  track search.
- **URL-addressable state:** `kind=<kind>`, `from=<period>`, `to=<period>`, and
  `view=cards|list`.
- **Drill-down:** Each card opens its static `/stories/[storySlug]/`; approved artist references may
  open eligible artist pages.
- **Supporting input:** Explicit selections from `rediscovery.json` and `abandonment.json`, joined
  only during public snapshot generation to authored story metadata and excerpts.
- **Uncertainty disclosure:** Returns crossing source gaps, open persistence, dormancy observation
  windows, right-censoring, confidence components, and superseded conclusions appear on the card
  when applicable.
- **Empty state:** Explain that no editorial stories match the selected kind/range; do not fall back
  to unreviewed analytical candidates.
- **Tabular alternative:** A story index lists title, kind, approved period, evidence status,
  qualification, and link, without track details unless the story was manually allowlisted.
- **Bounded export/share action:** Share the filtered index; stories are printable, but analytical
  candidate lists are not downloadable from this route.

### Route: `/stories/[storySlug]/`

- **Question:** What does this selected return or period of dormancy reveal, and what evidence
  supports that interpretation?
- **Narrative role:** The most editorial route: one reviewed story with a transparent boundary
  between personal recollection and approved analytical evidence.
- **Default view:** Authored title and narrative, approved artist or selected-track identity,
  reduced-date evidence, classification/status, parameters, coverage warning, and related era when
  available.
- **Filters:** None. A story is a fixed, versioned editorial object; superseded analytical context
  is shown as history rather than replaced through a filter.
- **URL-addressable state:** The approved `storySlug` only; optional fragment identifiers address
  stable sections without changing data.
- **Drill-down:** Link to an eligible artist, related public era state, methodology definition, or a
  later approved story that supersedes the earlier conclusion.
- **Supporting input:** One approved selection from `rediscovery.json` or `abandonment.json`, one
  authored story object, optional featured-artist content, and an approved selected-track record
  when the story names a track.
- **Uncertainty disclosure:** Show prior/return period at approved granularity, absence gap, return
  intensity, persistence, related era, or dormancy confidence and observation window as applicable;
  explicitly state that source gaps can resemble absence and dormancy is reversible.
- **Empty state:** Unknown, withdrawn, or unapproved slugs return the same static not-found
  experience and reveal no private selection metadata.
- **Tabular alternative:** A compact evidence table names every displayed approved value,
  parameter, status, coverage qualification, as-of date, and supersession link.
- **Bounded export/share action:** Share or print the fixed story URL; there is no raw analytical or
  track-history download.

### Route: `/explore/`

- **Question:** How does the approved history change when I inspect a bounded metric, time range,
  or eligible artist selection?
- **Narrative role:** Serve the secondary analytical visitor after the long-form story has supplied
  context; this is deeper exploration, not an operational dashboard.
- **Default view:** Monthly full-history `play_count` over the complete approved range with coverage
  context, a written summary, and no artist selected.
- **Filters:** Approved date range, `grain=month|quarter|year`, bounded eligible-artist interval
  context, and `view=chart|table`. The volume metric remains full-history `play_count`; selected
  artists add interval context, not an unavailable artist-volume series.
- **URL-addressable state:** `from=<period>`, `to=<period>`, `grain=<grain>`, repeated
  `artist=<publicSlug>`, and `view=<view>`.
- **Drill-down:** A period links to `/history/`; an admitted artist links to its static detail;
  metric and uncertainty definitions link to `/methodology/`.
- **Supporting input:** `volume.json`, `coverage.json`, and the eligible bounded subset of
  `artist-eras.json`. The first release does not require arbitrary cross-tabulation or a new runtime
  analytical query.
- **Uncertainty disclosure:** Every state retains the common envelope. The first release explains
  Spotify-backed duration and thresholded-count scope but does not offer those unavailable metrics
  as interactive state.
- **Empty state:** Preserve the selected controls, state that no approved aggregate matches, offer a
  reset, and do not infer zero listening when the range lacks evidence.
- **Tabular alternative:** The filtered chart's exact approved rows, coverage context, total, and
  definitions appear in a table that updates with the same URL state.
- **Bounded export/share action:** Share the allowlisted state; download only the displayed public
  rows when a prebuilt, P6-02-approved view export exists.

### Route: `/methodology/`

- **Question:** What do the published measures mean, what evidence supports them, and what remains
  unknown or private?
- **Narrative role:** Provide the trust contract for the entire site in plain language with optional
  technical depth.
- **Default view:** Definitions for canonical play count, Spotify-only duration, reconciliation,
  artist eras, rediscovery, dormancy, coverage, timezone, as-of/publication dates, selection, and
  privacy/publication review.
- **Filters:** A table of contents and `topic=<anchor>` enhancement only; methodology is not
  personalized or queried.
- **URL-addressable state:** Stable section fragments and, if enhanced, an equivalent `topic`
  anchor that resolves to the same server-rendered section.
- **Drill-down:** Links return to representative public views and to public-facing version/privacy
  disclosures, never to private files or internal database documentation.
- **Supporting input:** Public manifest/envelope metadata projected from every analytical artifact,
  public publication metadata defined by P6-02, and authored methodology content.
- **Uncertainty disclosure:** This route is the expanded disclosure, but it does not replace the
  adjacent summary on each analytical view.
- **Empty state:** Methodology remains fully useful even when no public snapshot or optional genre
  artifact is available; unavailable sections state their status explicitly.
- **Tabular alternative:** A definition register maps each public measure to definition, source
  scope, denominator, parameters, version, coverage requirement, and known limitation.
- **Bounded export/share action:** Share stable section URLs and offer a print-friendly document;
  there is no data export.

### Route: `/lab/genres/`

- **Question:** What tentative genre-era patterns appear in the currently usable enrichment, and
  how much of the history can that evidence actually describe?
- **Narrative role:** Optional experimental lab, isolated from the first-release thesis and absent
  entirely unless P6-09 activates it after reviewing the intended public snapshot.
- **Default view:** If activated, a bounded raw-tag interval view preceded by the experimental
  status and current usable-event coverage; no genre view appears on `/` as complete history.
- **Filters:** Approved range and bounded public genre selection. Mode remains `raw` while taxonomy
  is `null`; unsupported curated or track-level modes are not offered.
- **URL-addressable state:** `from=<period>`, `to=<period>`, repeated `genre=<publicSlug>`, and
  `view=timeline|table`.
- **Drill-down:** Evidence opens methodology coverage/freshness definitions, not unreviewed provider
  payloads or an artist long tail.
- **Supporting input:** `genre-eras.json` only after P6-09 activation and P6-02 public projection,
  plus authored experimental framing.
- **Uncertainty disclosure:** Always show `musicbrainz`, `raw` mode, taxonomy `null`, artist-level
  weighting, `genre-contribution-v2`, freshness, overall and across-time usable-event coverage, and
  the risk that current provider tags are sparse, noisy, or not historically contemporaneous.
- **Empty state:** If activated with no usable public intervals, explain the coverage shortfall and
  show methodology; if not activated, the route and its data are omitted rather than shipped as a
  placeholder.
- **Tabular alternative:** Public interval and coverage tables repeat provider, mode, taxonomy,
  weighting, freshness, and denominators in captions.
- **Bounded export/share action:** Share only an activated public state; any download is a
  separately approved experimental view and never implies complete history.

## Stable input and interaction map

The private analytical bundle is an upstream source for P6-04, not a deployable asset. The site
will eventually read only the narrower approved public artifacts defined by P6-02. This mapping
fixes which stable implemented contract can support each public behavior without authorizing all of
its private fields.

| Public behavior | Stable upstream input | Permitted interpretation |
| --- | --- | --- |
| Long-view period values, grain switch, rolling context | `volume.json` / `listening-volume-v1` in `analytical-result-v2` | Canonical monthly `play_count`, regrouped only to coarser periods; alternate metrics require a new versioned upstream artifact |
| Source ranges, yearly evidence, gaps, overlap, unresolved and duration context | `coverage.json` / `coverage-v2` | Aggregate evidence and canonical coverage; source evidence counts are not canonical play counts |
| Artist timeline, overlap, peak and component inspection | `artist-eras.json` / `artist-era-v1` | Parameterized intervals over eligible artists, never a permanent label or exhaustive public catalog |
| Rediscovery classification and selected return evidence | `rediscovery.json` / `rediscovery-v1` | Manually selected, granularity-reduced stories with gap and persistence qualification |
| Dormancy status, confidence, observation and supersession | `abandonment.json` / `abandonment-v1` | Reversible as-of observations over manually selected eligible artists |
| Conditional genre interval and coverage inspection | `genre-eras.json` / `genre-era-v2` | Experimental raw MusicBrainz artist-level evidence only if P6-09 activates it |
| Narrative annotations, featured artists, story order and personal interpretation | Versioned authored public content | Editorial framing; analytical facts resolve through approved public references |
| Disclosures, version/as-of labels and methodology definitions | Approved public manifest plus projected analytical envelopes | The same definitions and limitations used by the visible view |

All visualization, filter, table, disclosure, drill-down, share, and export interactions are
projections of the rows above. No interaction reads `data/inputs`, source-shaped tables, SQLite,
the private `data/outputs/analytics-v2` directory, a runtime API, or a hosted service.

## Editorial content model

Authored content and analytical/publication data remain separate, versioned inputs. Authored files
may contain publishable prose and references to approved public objects; they may not copy a source
record or private analytical record into prose front matter to bypass the public projection.

### Common authored fields

Every annotation, featured-artist entry, and story has a content schema version, public slug,
publication status, title, short summary, structured prose body, placement/order, accessibility
summary, and a list of public data references. P6-02 defines the exact serialized schema and slug
policy. A reference resolves only against an approved public snapshot; it is never a database ID,
source fingerprint, provider payload key, private path, or exact event locator.

Analytical assertions in prose reference an approved aggregate or evidence block so review can
detect a stale claim after a snapshot change. Personal memory and interpretation are explicitly
labeled editorial and need not masquerade as measured fact.

### Annotation

An annotation adds a short authored observation to one route section or public period. Its anchor
uses a public route/series reference and approved period label. It includes concise visible text and
an expanded accessible explanation. It does not contain a hidden raw timestamp, event, or artist ID.

### Featured artist

A featured-artist entry references an eligible public artist slug and provides authored context,
placement, and optional related story references. Names and interval facts render from the approved
public artist record so an eligibility change or withdrawal cannot leave an orphaned private name
embedded in content metadata.

### Selected track story

A selected-track story references a separately reviewed manual track-selection entry in the public
publication artifacts. The selection entry supplies only the approved artist display name, track
display name, story slug, and public track slug; it does not resolve to a private analytical
candidate or supply track-level analytical evidence. The authored story supplies title treatment,
narrative, interpretation, and related public references. Any numerical or classified evidence in
the story must independently resolve to its stated bundle-backed scope. Removing or withdrawing the
manual selection makes the track identity fail validation instead of falling back to a private
analytical record. No story can enumerate the track's plays or reconstruct an event history.

### Review invariants

- Authored content cannot introduce a track name merely because it appears in private rediscovery
  output; the wholly manual, explicitly reviewed track-selection allowlist is authoritative.
- A selected track is editorial identity, not evidence that a track-level return, gap, persistence,
  or listening metric was analytically established.
- Annotations and stories cannot include source filenames, paths, account identifiers, internal
  IDs, fingerprints, precise private events, or excluded source fields.
- Numeric claims and analytical classifications must resolve to the same approved snapshot/version
  shown by the page, or be clearly labeled non-analytical editorial context.
- Withdrawn or superseded public references fail the build or render an explicitly authored
  supersession path; they never silently resolve to a different entity.

## Responsive and accessible experience contract

These requirements apply to every core route, default view, enhanced state, table, disclosure, and
editorial story. P6-03 may select implementation tools but may not weaken this baseline.

### Responsive structure

- The authored reading order is the DOM order at every viewport. Layout changes cannot change the
  meaning or place disclosures away from the evidence they qualify.
- Core content works at 320 CSS pixels without page-level horizontal scrolling. Wide data tables
  may scroll inside a labeled region with keyboard access and a visible instruction.
- Text reflows at 200% zoom, controls remain reachable, touch targets do not rely on precision, and
  chart summaries/tables do not disappear at narrow widths.

### Keyboard and focus

- A skip link reaches main content; landmarks and headings identify navigation, main content,
  complementary disclosures, and the footer.
- Every control and disclosure works with keyboard alone, has a persistent visible focus style,
  and keeps focus in a predictable position after an update. There are no hover-only actions,
  keyboard traps, or focus-order changes caused by visual layout.
- Charts are not required to expose every mark as a focus stop. Their controls, summary, selected
  value, and equivalent table provide the operable experience without an exhausting tab sequence.

### Screen readers and nonvisual meaning

- Every analytical figure has a unique name, concise finding, metric/scope description, coverage
  qualification, and relationship to its table. Tables use captions and proper row/column headers.
- Filter changes update a nearby textual result summary and announce the completed change through a
  restrained live region. Loading, invalid-state, error, and empty-state messages are textual.
- Color, shape, motion, hover, and spatial position never carry meaning alone. Series, source gaps,
  selection, confidence, and experimental status also use text, pattern, symbol, or explicit labels.

### Color, contrast, and motion

- Text and essential interface graphics meet WCAG 2.2 AA contrast. Focus indicators and data marks
  remain distinguishable in high-contrast/forced-color settings.
- The presentation may use deliberate editorial motion for orientation, but nothing auto-plays,
  flashes, or requires animation to understand sequence or change.
- `prefers-reduced-motion: reduce` removes nonessential transforms, parallax, animated drawing, and
  smooth scrolling while preserving immediate state changes and content.

### Progressive enhancement and no JavaScript

- The static response contains the route title, authored narrative, default analytical summary,
  disclosures, default table, relevant annotations, navigation, and methodology links.
- Native links and forms express meaningful route state. JavaScript may add instant filtering,
  chart coordination, copy-link convenience, and richer focus management, but it cannot be the only
  route to content or methodology.
- With JavaScript disabled, every core route remains navigable and readable, the default public
  state is complete, static eligible artist/story URLs work, and approved downloads are ordinary
  links. Unsupported enhanced combinations resolve to a static default rather than a blank shell.
- The conditional genre route follows the same rule if activated; if deferred, neither its HTML nor
  data ships.

## Explicit phase boundaries

P6-01 intentionally leaves these decisions to their named checkpoints:

- P6-02 decides exact public fields, date granularity, slugs, eligibility/significance thresholds,
  result limits, downloads, artwork/fonts, analytics, third-party requests, and publication review.
- P6-03 confirms build, charting, interaction, styling, test, browser, performance, and deployment
  strategies. This specification requires outcomes, not a framework implementation.
- P6-04 defines and implements public artifacts/view models. It may project less than a private
  analytical artifact contains, never more than P6-02 authorizes.
- P6-05 through P6-08 implement the core routes and content system.
- P6-09 either activates the complete experimental genre route under its disclosure gate or omits
  the route and data. Partial or unqualified activation is not a valid outcome.

The initial microsite has no requirement for raw export access, a SQLite connection, a production
server, a hosted database/query service, visitor accounts, or an event-level listening log.
