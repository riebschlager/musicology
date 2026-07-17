# Musicology Project Approach

Status: Draft for review  
Last updated: 2026-07-17

## 1. Purpose

Musicology is a local-first system for importing, reconciling, exploring, and eventually visualizing more than twenty years of personal music-listening history.

The initial project will use TypeScript on Node.js, pnpm, and SQLite. Its first responsibility is to turn historical Spotify and Last.fm data into a trustworthy, explainable analytical dataset. Later responsibilities include incremental Last.fm synchronization, enrichment, reusable analysis, web visualizations, and other artifacts.

The system should make it possible to answer questions such as:

- How has listening volume changed by week, month, year, and life period?
- Which artists defined particular eras, and when did those eras begin or fade?
- Which genres rose, overlapped, or disappeared over time?
- Which artists or tracks were rediscovered after meaningful absences?
- Which formerly important artists appear to have been abandoned?

The project is not merely an importer. It is intended to become a durable personal music-history laboratory whose findings remain traceable to the original evidence.

## 2. Confirmed product decisions

- TypeScript will be used rather than plain JavaScript.
- The first version will model music tracks only.
- Podcasts, audiobooks, and video events will not become canonical listening events in version 1.
- Historical source files will remain unchanged.
- Sensitive source fields will not be loaded into SQLite.
- Cross-source reconciliation will be conservative.
- The initial analytical priorities are listening volume, artist and genre eras, rediscovery, and abandonment.
- The runtime will be the active Node.js LTS line and the package manager will be pnpm.
- Calendar-based analysis will default to the `America/Chicago` timezone.
- Spotify country and platform fields will be omitted from the version 1 database.
- The default play count will include every canonical track event; thresholded counts will be optional secondary metrics.
- The project will remain local-first. A hosted database or service is not required for initial ingestion, analysis, or visualization.

As of this draft, Node.js 24 is the active LTS line; Node.js 26 remains Current until October 2026. The repository should pin the selected major version without pinning this document to a particular patch release. See the official [Node.js release table](https://nodejs.org/en/about/previous-releases).

## 3. Current source inventory

The repository currently contains the following historical inputs under `data/inputs`:

| Source | Records | Observed range | Notes |
| --- | ---: | --- | --- |
| Spotify audio | 61,114 | 2011-08-23 through 2026-02-14 | Four export files; 61,031 track events and 83 podcast episodes |
| Spotify video | 583 | 2018-08-24 through 2026-02-14 | Out of scope for version 1 |
| Last.fm | 62,266 | 2005-02-13 through 2026-04-26 | Track scrobbles; no exact duplicate rows detected |

Notable characteristics of the archive:

- Last.fm supplies the only coverage before 2011.
- The Last.fm export has no events from 2017 through 2024. It resumes in 2025.
- Spotify coverage is sparse in some early years and continuous from approximately 2016 onward.
- The Spotify audio files contain 401 extra rows that are exact full-record duplicates, distributed across 388 duplicate groups.
- Spotify records when playback stopped and includes `ms_played`.
- Last.fm records a scrobble timestamp but does not include listening duration.
- In overlapping samples, the Last.fm timestamp often aligns with a Spotify-derived start time: Spotify stop time minus `ms_played`.
- Last.fm album data is incomplete: approximately one sixth of scrobbles have no album name, and roughly one third have no album identifier.
- The Spotify files contain fields such as IP address and device/platform context that are unnecessary for the current analytical goals.

These observations are a baseline, not permanent assumptions. Import validation should reproduce them and clearly report changes when replacement or additional exports are introduced.

## 4. Goals and non-goals

### 4.1 Initial goals

1. Import each source repeatably without modifying it.
2. Validate source schemas and report malformed or unsupported records.
3. Preserve source provenance for every accepted event.
4. Remove exact within-source duplication from canonical analysis while preserving the duplicated source rows as evidence.
5. Reconcile strong Spotify/Last.fm matches without collapsing ambiguous events.
6. Incrementally fetch new Last.fm scrobbles through an idempotent command.
7. Provide stable analytical views or queries for the first insight families.
8. Make uncertainty, gaps, and source limitations visible in every downstream result.
9. Keep the database portable, inspectable, and easy to rebuild from source.

### 4.2 Initial non-goals

- Podcast, audiobook, or video analysis
- Real-time scrobbling to Last.fm
- Editing listening history on Spotify or Last.fm
- A cloud-hosted multi-user service
- A universal music metadata catalog
- Perfect automatic resolution of every artist, release, and track alias
- Treating inferred genre, rediscovery, or abandonment labels as objective facts
- Building the web application before the data pipeline is trustworthy

## 5. Design principles

### 5.1 Original evidence is immutable

Files in `data/inputs` are evidence. Import and synchronization processes must never rewrite them. New exports should be added as new inputs and identified by a content hash.

### 5.2 Canonical data is reproducible

The SQLite database is derived state. It should be possible to delete it, run migrations and imports, and reproduce the same canonical result from the same inputs and reconciliation-rule version.

### 5.3 Provenance is first-class

Every canonical listening event must link to one or more source records. A merged Spotify/Last.fm event does not erase either record.

### 5.4 Uncertainty is stored, not hidden

Automatic matches require strong evidence. Candidate matches, confidence components, rule versions, and manual decisions should be retained. Ambiguity should produce two events plus a review candidate, not a silent merge.

### 5.5 Identity and display text are separate

Normalized text may help search and matching, but it must not replace original artist, album, or track spelling. Display values remain source-derived and aliases remain auditable.

### 5.6 Metrics declare their coverage

Counts can use the full reconciled history. Listening time, completion, and skip behavior can only use records with suitable Spotify evidence. Queries and visualizations must state their source and coverage rather than mixing incomparable measures.

### 5.7 Privacy defaults to minimization

The database should contain only fields needed for the project. IP addresses, user-agent strings, account usernames copied from private exports, secrets, Spotify country, and Spotify platform are excluded from version 1. They may remain in the unchanged historical files, which should not be committed to a public repository.

## 6. Proposed architecture

The first architecture is a set of composable command-line workflows sharing a domain model and a SQLite database:

```text
Historical files ──> validate ──> source-shaped import tables ──┐
                                                               │
Last.fm API ───────> fetch ────> source-shaped import tables ──┤
                                                               v
                                            normalize identities
                                                               │
                                                               v
                                             reconcile evidence
                                                               │
                                                               v
                                         canonical listening events
                                                               │
                                                               v
                                        analytical views / exports
                                                               │
                                                               v
                                      web visualizations + artifacts
```

This should begin as one Node.js package, not a monorepo. The pipeline, analytics, and future web server can be separated later if the boundaries become useful in practice.

### 6.1 Proposed repository shape

```text
data/
  inputs/                 # immutable private exports
  database/               # generated SQLite database; not committed
  outputs/                # generated reports or exchange files
migrations/               # ordered, committed SQL migrations
queries/                  # substantial named analytical SQL
src/
  cli/                    # command entry points and output formatting
  config/                 # paths, environment, and runtime configuration
  db/                     # connection, migrations, transactions
  domain/                 # shared types and invariants
  importers/
    spotify/
    lastfm-export/
  sync/
    lastfm/
  identity/               # normalization and alias handling
  reconciliation/         # candidates, scores, and decisions
  analytics/              # parameterized analyses and result contracts
tests/
  fixtures/               # small synthetic and anonymized source samples
  integration/
```

The private exports and generated database should be ignored by Git. Small anonymized or synthetic fixtures should be committed for deterministic tests.

## 7. Technology approach

### 7.1 Runtime and language

- Node.js 24 LTS for the initial implementation
- TypeScript in strict mode
- ECMAScript modules
- pnpm with a committed lockfile
- Node's built-in test runner unless a concrete testing need justifies a larger framework
- Runtime validation at all external boundaries; TypeScript types alone do not validate JSON or HTTP responses

The project should pin Node 24 at the repository level and use an engines constraint that allows compatible Node 24 patch releases. The pin can move to Node 26 after it reaches LTS and the project has passed its test suite there.

### 7.2 SQLite access

The recommended initial database adapter is `better-sqlite3`, used behind a small project-owned interface. It supports current Node releases and fits a local, sequential, transaction-heavy command-line workload. The built-in `node:sqlite` module is attractive, but in Node 24 it is still documented as a release candidate rather than stable; isolating the adapter preserves the option to adopt it later. See the current [Node 24 SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) and [`better-sqlite3` releases](https://github.com/WiseLibs/better-sqlite3/releases).

The project should prefer explicit SQL migrations and explicit analytical SQL over hiding the schema behind a broad ORM. A thin typed query layer can be introduced if it demonstrably improves correctness without making analytical queries harder to inspect.

Recommended database settings and practices:

- Enable foreign-key enforcement for every connection.
- Use transactions around each import batch and reconciliation run.
- Use write-ahead logging when it improves local read/write behavior.
- Use prepared statements and bound parameters.
- Store migrations in version control and record applied migrations in SQLite.
- Use unique constraints plus SQLite UPSERT behavior to guarantee idempotency. SQLite documents the relevant conflict behavior in its [UPSERT reference](https://www.sqlite.org/lang_upsert.html).
- Run foreign-key and integrity checks as part of validation and backup workflows.
- Back up the database before destructive migrations or large manual reconciliation changes.

### 7.3 Likely focused dependencies

Dependencies should be selected during implementation and kept deliberately small. Likely categories are:

- SQLite adapter: `better-sqlite3`
- Runtime schema validation: a library such as Zod
- TypeScript execution during development: a tool such as `tsx`
- Command parsing: a small CLI library only when subcommands and help text justify it
- Formatting and linting: repository-wide tools with deterministic CI commands

No library choice in this section should override the core requirement that import behavior and reconciliation decisions remain testable and understandable.

## 8. Data layers and conceptual schema

The database should separate source evidence, music identity, reconciliation, and analytics.

### 8.1 Operational metadata

`schema_migration`

- Records applied schema migrations.

`ingest_run`

- One row per import or API synchronization attempt.
- Stores command type, start/end time, status, rule/schema versions, counts, and a safe error summary.

`source_file`

- Stores relative path, source type, byte size, content hash, observed range, and first/last ingest run.
- A content hash prevents accidental double-import under another filename.

`sync_cursor`

- Stores the last successful API boundary and synchronization metadata per source account.
- Must not contain the API key.

### 8.2 Source-shaped evidence

`spotify_play_source`

- One row for every accepted Spotify music-track record, including duplicates.
- Retains source file and ordinal position, stop timestamp, milliseconds played, track URI, source artist/album/track text, playback reasons, shuffle, skipped, offline state, and relevant content identifiers.
- Stores a deterministic source fingerprint.
- Does not store IP address, username, user-agent, or other excluded fields.

`lastfm_scrobble_source`

- One row for every accepted export or API scrobble.
- Retains source origin, source ordinal or API identity, scrobble timestamp, artist/album/track text, available MusicBrainz identifiers, loved status when available, and a deterministic source fingerprint.
- A record fetched from the API that already exists from the export should reuse or link to the same source evidence rather than create a second analytical event.

`rejected_source_record`

- Stores a safe error code, source location, and non-sensitive diagnostic summary for records that cannot be accepted.
- Raw payloads containing excluded fields should not be copied into this table.

### 8.3 Music identity

`artist`

- Canonical artist identity and preferred display name.

`artist_alias`

- Original or normalized aliases linked to an artist, with source and decision metadata.

`release`

- Canonical album, single, compilation, or unknown release when enough evidence exists.

`track`

- Canonical recording identity, artist relationship, preferred title, and optional release relationship.

`music_identifier`

- External identifiers attached to the appropriate entity, including Spotify track URI and MusicBrainz identifiers.
- Strong identifiers are evidence, not an assumption that every service models editions and recordings identically.

`identity_decision`

- Records manual merge, split, or alias decisions so that later imports reproduce them.

### 8.4 Canonical listening history

`listening_event`

- Represents the best current interpretation of one act of listening.
- Includes canonical track, canonical start time when known, end time when known, listened milliseconds when known, event status, and reconciliation-rule version.
- Keeps all track events, including short and skipped Spotify plays. Analytical queries decide which thresholds apply.

`listening_event_source`

- Many-to-many link between a canonical event and its source evidence.
- Stores the role of the evidence and the accepted match score or decision.

`reconciliation_candidate`

- Stores possible event pairs, feature-level scores, total confidence, rule version, state, and manual resolution.

This separation allows exact duplicates and cross-service duplicates to map to one canonical event without deleting source evidence.

### 8.5 Genre enrichment

Genre is not reliably present in the current exports. It must be modeled as enrichment rather than a property discovered during core ingestion.

`genre_tag`

- A raw or curated genre/tag vocabulary entry.

`artist_genre_evidence`

- A weighted relationship between artist and tag, including provider, fetch date, raw weight, and confidence.

`genre_mapping`

- Maps noisy or overly specific source tags to a curated analytical taxonomy without destroying the raw tag.

Genre-era analysis must report metadata coverage. An era chart based on genre data for only 55% of events should say so.

## 9. Time model

- Canonical timestamps are stored as UTC instants in an unambiguous representation.
- Spotify `ts` is a stop time according to Spotify's export documentation.
- A candidate Spotify start time is derived as `stop time - ms_played` and marked as derived.
- Last.fm API time boundaries are Unix timestamps in UTC.
- Calendar grouping uses an explicit presentation timezone rather than the machine's implicit timezone.
- The default presentation timezone is `America/Chicago`, but it remains explicit and configurable so individual analyses can intentionally use another timezone.
- Historical local time while traveling cannot be reconstructed reliably from the required version 1 fields. Analyses should not pretend otherwise.

The exact storage representation—integer epoch milliseconds or canonical UTC text—should be chosen once in the first migration and used consistently. Integer epoch milliseconds are the leading option because the sources include both milliseconds and seconds and reconciliation requires time arithmetic.

## 10. Import pipeline

Each importer should follow the same observable stages:

1. Discover explicitly supported files.
2. Compute a content hash and register an ingest run.
3. Parse incrementally where practical rather than retaining unnecessary copies in memory.
4. Validate the file-level and record-level schema.
5. Classify content and exclude non-music records from canonical version 1 processing.
6. Project only approved fields into source-shaped tables.
7. Create deterministic fingerprints and insert idempotently.
8. Resolve strong identifiers and known aliases.
9. Create or update canonical events and reconciliation candidates.
10. Commit the transaction and print a machine-readable and human-readable summary.
11. Run invariant checks and fail loudly if counts or relationships are inconsistent.

Re-running an importer against an unchanged file should result in no new source evidence and no changed canonical conclusions unless the reconciliation-rule version has intentionally changed.

### 10.1 Spotify-specific handling

- Only records with a Spotify track URI enter the version 1 music pipeline.
- Episode, audiobook, and video records are counted in validation summaries but are not inserted as canonical listening events.
- Exact full-row duplicates remain separate source rows but point to one canonical event.
- Zero-duration and very short plays are retained as evidence.
- Skip and completion concepts are derived analytically and must not be conflated with source fields.
- Excluded sensitive fields are never logged or copied to rejection diagnostics.

### 10.2 Last.fm export handling

- Millisecond timestamps in the current export are normalized to the canonical time representation.
- Empty album names and identifiers remain unknown; they are not replaced with invented values.
- Source artist and track text is preserved exactly alongside matching-normalized forms.
- The importer must tolerate missing optional identifiers without treating the scrobble as invalid.

## 11. Last.fm API synchronization

The synchronization command should use `user.getRecentTracks`. The endpoint does not require a user session, but it does require an API key. It supports `from` and `to` UTC boundaries, pagination, and up to 200 results per page. It may also return a currently playing item, which has no completed scrobble timestamp and must not be imported as a completed listening event. See the official [`user.getRecentTracks` documentation](https://www.last.fm/api/show/user.getRecentTracks).

### 11.1 Configuration and secrets

- Username and API key are provided through environment configuration.
- The API key is never stored in SQLite or logs.
- Local secret files are ignored by Git; a committed example file documents required variable names only.
- Requests use an identifiable project User-Agent as requested by Last.fm's [API introduction](https://www.last.fm/api/intro).

### 11.2 Safe incremental algorithm

1. Read the last successful cursor.
2. Subtract a configurable safety overlap from that timestamp.
3. Request pages with `limit=200`, an inclusive `from` boundary, and JSON output.
4. Ignore any currently playing item.
5. Validate every response and normalize only completed scrobbles.
6. Upsert source evidence by deterministic fingerprint.
7. Continue until all pages in the bounded response have been processed.
8. Reconcile new evidence in the same transaction or in a separately recorded follow-up run.
9. Advance the cursor only after the whole synchronization succeeds.

The overlap makes the operation resilient to boundary ambiguity, late appearance, and interrupted runs. Unique constraints make the overlap harmless.

### 11.3 Reliability behavior

- Use request timeouts and bounded retries with exponential backoff and jitter for transient failures.
- Honor rate-limit responses and do not continuously issue several calls per second.
- Cache or avoid redundant requests where practical and follow response cache headers.
- Record safe response metadata and counts, not API keys or entire unfiltered bodies.
- Leave the cursor unchanged after any partial failure.
- Support a dry-run mode and explicit `from`/`to` bounds for recovery.

Last.fm documents error 29 for rate limiting and asks clients to use reasonable request rates. Its terms also require compliance with enforced limits and suitable caching; see the [Last.fm API terms](https://www.last.fm/api/tos).

## 12. Identity normalization

Matching-normalized text should be produced by versioned, pure functions. It may include:

- Unicode normalization
- Case folding
- Trimming and whitespace collapsing
- Consistent punctuation handling
- Carefully scoped handling of common featuring-artist notation

Normalization must not casually remove meaningful qualifiers such as “live,” “remix,” “radio edit,” or movement numbers. Those often distinguish recordings.

Identity resolution priority should generally be:

1. A previously recorded manual identity decision
2. A strong service identifier linked by trusted evidence
3. A known alias relationship
4. A conservative composite of normalized artist, track, and release evidence
5. A new unresolved identity

Two records sharing normalized artist and track text are candidates, not automatically the same recording.

## 13. Reconciliation strategy

Reconciliation occurs in separate stages so each conclusion can be explained.

### 13.1 Within-source exact duplication

- Identical Spotify rows can automatically support one canonical event.
- All duplicated source rows remain linked to that event.
- Same timestamp and track but materially different source fields should be reviewed by explicit rules rather than treated as exact duplicates.
- Last.fm API/export overlap is deduplicated by a stable fingerprint before cross-source reconciliation.

### 13.2 Cross-source candidate generation

A Spotify and Last.fm record may become candidates when:

- Their resolved or normalized artists are compatible.
- Their resolved or normalized tracks are compatible.
- The Last.fm timestamp is close to the Spotify-derived start time.
- The records occur within a tightly bounded time window.

Candidate generation should use indexed blocking keys so it never compares every Spotify row with every Last.fm row.

### 13.3 Feature-level confidence

The match record should preserve separate evidence components rather than only one opaque number:

- Exact strong-identifier agreement
- Artist identity agreement
- Track identity agreement
- Album agreement when available
- Difference from Spotify-derived start time
- Plausible duration and ordering relative to neighboring events
- Conflict with another equally plausible candidate
- Indicators that the Spotify play was too short to plausibly scrobble

### 13.4 Conservative decision policy

- Auto-merge only high-confidence, unambiguous candidates.
- Never auto-merge when strong identifiers conflict.
- Keep medium-confidence candidates separate and available for review.
- Keep low-confidence records separate without creating review noise unless a later rule requests it.
- Make thresholds configuration with a version, tests, and a recorded rationale.
- Re-running a newer rule version must not erase prior decisions; it should produce an auditable superseding result.

The initial exact-time inspection found strong matches in parts of 2016, 2025, and 2026, consistent with Last.fm's observed coverage gaps. This supports the derived-start strategy but does not justify using it as the sole match criterion.

## 14. Analytical contract

Every analytical result should include or make derivable:

- Metric name and definition
- Date range and presentation timezone
- Included sources
- Number of canonical events
- Number or proportion of unresolved events
- Metadata coverage where enrichment is required
- Parameters such as minimum plays or absence threshold
- Analysis/rule version

### 14.1 Listening volume over time

Provide at least two distinct metric families:

`play_count`

- Counts reconciled canonical listening events.
- Includes every canonical track event by default, including short and skipped Spotify-backed events.
- Available across the full Last.fm/Spotify history.
- Thresholded variants, such as plays lasting at least 30 seconds, may be provided as optional secondary metrics and must be named distinctly from the default count.

`listened_ms`

- Sums Spotify-backed milliseconds only.
- Must be labeled Spotify-only.
- Must not estimate twenty years of duration by assigning assumed track lengths to Last.fm-only events.

Useful grains include day, ISO week, month, quarter, and year. Rolling averages and year-over-year comparisons should be derived from stable base views.

### 14.2 Artist eras

An artist era should be computed, not hand-waved. Candidate signals include:

- Rolling play count
- Artist share of all listening in the same window
- Rank within a window
- Consecutive active windows
- Change from the artist's earlier baseline
- Minimum absolute activity to prevent tiny samples from appearing dominant

The first implementation should expose the components and allow era parameters to change. A useful result is a set of intervals with strength, peak date, play count, share, and evidence—not a single permanent label.

### 14.3 Genre eras

Genre eras build on the artist-era approach but require weighted genre evidence. A track may contribute fractionally to several genres. Results must expose:

- Taxonomy version
- Enrichment provider and fetch age
- Percentage of events with usable genre coverage
- Raw versus curated tag option
- Whether weights are artist-level or track-level

Genre enrichment should be a later pipeline stage so unreliable tags cannot block core listening-history work.

### 14.4 Rediscovery

A rediscovery is a return to a previously meaningful artist or track after a configurable absence. The analysis should distinguish:

- One-off return
- Sustained rediscovery
- Return that begins a new era

Initial candidate absence thresholds might include 90, 180, and 365 days. “Previously meaningful” should require a minimum historical play count or era strength. The output should show the last prior listen, gap length, return intensity, and whether listening persisted.

### 14.5 Abandonment

Abandonment is retrospective and uncertain. It should be expressed as “dormant” or “likely abandoned as of a date,” never as a permanent fact.

Candidate features include:

- Historical importance or peak era strength
- Time since last listen
- Former listening cadence
- Number of prior active periods
- Observation-window length after the last listen
- Whether a later rediscovery invalidated an earlier label

Recent artists are right-censored: the archive has not observed enough future time to conclude abandonment. Results must state the as-of date and confidence components.

## 15. Data-quality and coverage reporting

A dedicated coverage report should be treated as a product feature. It should include:

- Events by source and year
- Overlap by source and year
- Exact and inferred duplicate counts
- Accepted, rejected, unresolved, and non-music counts
- Missing artist, album, identifier, and duration rates
- Percentage of canonical events backed by Spotify, Last.fm, or both
- Genre-enrichment coverage
- Long gaps and suspicious discontinuities
- First and last observation for each source

Visualizations should be able to consume this report so gaps are visible rather than buried in footnotes.

## 16. Command-line workflow

The exact command names can be refined during implementation, but the intended workflow is:

```text
pnpm db:migrate
pnpm import:spotify [paths...]
pnpm import:lastfm-export [path]
pnpm sync:lastfm [--from ...] [--to ...] [--dry-run]
pnpm reconcile [--rule-version ...] [--dry-run]
pnpm validate
pnpm report:coverage
pnpm analyze:volume
pnpm analyze:artist-eras
pnpm analyze:rediscovery
pnpm analyze:abandonment
```

Commands should use meaningful exit codes and support concise human output plus structured JSON output for future automation.

## 17. Testing and verification

### 17.1 Unit tests

- Source schema validation
- Timestamp conversion and derived start times
- Unicode and normalization edge cases
- Deterministic fingerprints
- Match feature calculations and threshold boundaries
- Rediscovery and abandonment interval logic

### 17.2 Integration tests

- Import small synthetic Spotify and Last.fm fixtures into a temporary database.
- Import the same fixture twice and prove idempotency.
- Simulate interrupted and retried Last.fm pagination.
- Confirm a currently playing Last.fm item is ignored.
- Confirm exact duplicated Spotify records produce one canonical event with multiple evidence links.
- Confirm ambiguous matches stay separate.
- Confirm excluded sensitive fields do not exist in schema, logs, or rejection output.
- Apply all migrations to an empty database and rebuild it from fixtures.

### 17.3 Archive-level invariants

- Every accepted source music record links to exactly one current canonical interpretation or an explicit unresolved state.
- Every canonical event has at least one source link.
- No canonical merge contains conflicting strong identifiers without a manual decision.
- Foreign-key and integrity checks pass.
- A no-change rerun inserts no additional evidence.
- Source files retain their original content hashes.
- Coverage reports reconcile to table counts.

Full archive tests can run locally without committing private data. CI should use synthetic fixtures only.

## 18. Observability and recoverability

- Each command records an `ingest_run` or equivalent operation record.
- Console output reports discovered, accepted, skipped, duplicated, rejected, matched, and unresolved counts.
- Logs are structured enough to diagnose failures but do not contain secrets or sensitive source fields.
- Transactions prevent half-imported files and half-advanced sync cursors.
- The generated database is disposable because inputs and migrations are authoritative.
- Manual identity and reconciliation decisions should be exportable as a small versionable artifact so they are not trapped only in a disposable database.
- Database backups should be timestamped and created before operations that revise many manual decisions.

## 19. Delivery phases

### Phase 0: Project foundation

- Initialize the TypeScript/pnpm/Node 24 project.
- Add formatting, linting, tests, configuration validation, and Git ignore rules.
- Create the database adapter, migration runner, and initial schema.
- Add anonymized fixtures.

Exit condition: an empty database can be created, migrated, validated, and tested deterministically.

### Phase 1: Historical ingestion

- Implement Spotify audio validation and import.
- Implement Last.fm export validation and import.
- Add source hashes, import summaries, rejection handling, and idempotency.
- Produce the first coverage report.

Exit condition: all supported historical music records are represented as source evidence, a second import is a no-op, and excluded data is absent from SQLite.

### Phase 2: Identity and reconciliation

- Implement versioned normalization.
- Resolve strong identifiers and cautious aliases.
- Collapse exact within-source duplicates at the canonical-event layer.
- Generate and score cross-source candidates.
- Auto-merge only high-confidence unambiguous matches.
- Add an inspectable review/export workflow for ambiguous candidates.

Exit condition: every source track has a canonical or explicit unresolved interpretation, with reproducible counts and provenance.

### Phase 3: Incremental Last.fm synchronization

- Implement API client, response validation, pagination, retries, safety overlap, and cursor behavior.
- Add dry-run and bounded recovery modes.
- Test interrupted sync and repeat sync behavior.

Exit condition: repeated synchronization safely adds only newly observed scrobbles and never advances the cursor after partial failure.

### Phase 4: Initial analytics

- Add stable base views for canonical events and coverage.
- Implement listening-volume queries.
- Implement artist-era intervals.
- Implement rediscovery and abandonment analyses with configurable thresholds.
- Export structured results suitable for visualization.

Exit condition: each analysis has a documented definition, coverage metadata, tests, and reproducible output.

### Phase 5: Genre enrichment and genre eras

- Select and document one or more metadata sources.
- Cache raw enrichment evidence with fetch dates.
- Build a curated mapping layer without discarding raw tags.
- Implement coverage-aware genre-era analysis.

Exit condition: genre results report taxonomy, weighting, provider, and coverage and can be regenerated independently of core ingestion.

### Phase 6: Visualization and artifact layer

- Choose the first web stack based on the analytical output contracts rather than prematurely coupling it to import code.
- Build interactive timelines and era/rediscovery views.
- Make source coverage and uncertainty visible in the interface.
- Add static export formats for other artifacts.

Exit condition: visualizations consume stable analytical interfaces and do not need direct knowledge of raw export formats.

## 20. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| False cross-source merges | Conservative thresholds, feature-level evidence, strong-identifier conflict rules, review state |
| One listen counted twice | Exact source fingerprints, canonical source links, overlap-aware reconciliation |
| Legitimate repeated listens collapsed | Require identity plus time evidence; distinguish source duplication from repeated behavior |
| Historical gaps misread as behavior | First-class yearly coverage report and source annotations in outputs |
| Duration metrics overstate coverage | Keep full-history count metrics separate from Spotify-only duration metrics |
| Genre tags are noisy or anachronistic | Store raw evidence, curated mappings, weights, fetch dates, and coverage |
| “Abandonment” overclaims the future | As-of dates, right-censoring, confidence, and reversible labels |
| API retry creates duplicates | Safety overlap plus deterministic unique fingerprints |
| API failure loses events | Advance cursor only after complete success; bounded recovery modes |
| Sensitive data leaks into derived artifacts | Schema allowlist, log redaction, private input paths, explicit tests |
| Database becomes irreproducible | Immutable inputs, committed migrations, versioned rules, exportable manual decisions |
| Tool churn constrains the project | Thin adapters, explicit SQL, small dependency surface, stable domain contracts |

## 21. Decisions still to make

These decisions are intentionally deferred until they become relevant:

1. Which genre/enrichment providers and curated taxonomy to use.
2. The exact high-confidence reconciliation threshold after inspecting a labeled sample of real overlap.
3. Whether manual reconciliation decisions live in a committed private data file, a database export, or both.
4. The initial web framework and visualization libraries.

## 22. Immediate next step

Review and revise this approach before project scaffolding begins. Once accepted, Phase 0 should translate these principles into a minimal TypeScript project, a versioned schema, synthetic fixtures, and executable invariants without beginning visualization work prematurely.
