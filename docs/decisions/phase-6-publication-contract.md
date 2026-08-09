# Phase 6 public-data and publication privacy contract

**Task:** P6-02
**Decision date:** 2026-08-09
**Status:** accepted for P6-03 and P6-04 implementation

**Amendment:** P6-02 was revised on 2026-08-09 before P6-04 implementation. Selected-track public
identity is now wholly manual editorial detail under `public-selection-policy-v2`; it does not
resolve against or imply a private analytical track candidate. Artist eligibility, analytical
evidence, and numerical claims remain bundle-backed.

## Decision and dependency evidence

P6-01 is complete at the current branch tip. Its product specification maps every first-release
route to the stable Phase 4 `analytical-export-v2` bundle or to versioned authored public content.
Phase 5's recorded fitness status remains **experimental; not fit for an unqualified user-facing
genre-era view**. This contract therefore defines the optional genre-lab artifact, but P6-09 must
still activate the route as a whole or omit both its HTML and data.

The implemented state and the plan agree: the site needs no raw source access, new analytical
query, SQLite connection, hosted service, or event-level data. This decision defines the public
boundary only. P6-04 will implement private-bundle loading, projection, candidate staging, diffing,
approval, supersession, and rollback against this contract.

Publication is default-deny. A field is public only when both the field register below and the
closed runtime schema in `src/publication/contract.ts` admit it. Every object rejects unknown keys,
and the contract recursively rejects named private fields even when they are nested. A future field,
artifact, selection rule, or policy requires an explicit schema or policy version change.

## Classification rules

The four classifications have deliberately different boundaries:

- **Private-only:** may exist in immutable inputs, SQLite, ignored private analytical outputs, or a
  private candidate-generation workspace, but never in a public candidate artifact, review report,
  approved snapshot, site build, URL, error, or browser payload.
- **Public aggregate:** a bounded value over multiple canonical events with no private entity key.
  It may cross the boundary only at the public grain and in its exact artifact schema.
- **Eligible artist detail:** artist display text and aggregate era evidence may cross only after
  the executable significance, slug, and result-limit rules admit the artist.
- **Manually selected editorial detail:** authored content, selected analytical evidence, artist
  text, and at most one selected track identity may cross only through an explicit reviewed story,
  annotation, featured-artist, or track allowlist entry.

### Complete current candidate-field register

This register covers every field in the current `analytical-export-v2` wrapper, its six artifacts,
and the P6-01 authored-content model. “Project” means a new field with the stated reduction or
renaming; “omit” means it is private-only. Any field not listed here is private-only by default.

| Current candidate path | Classification | Public treatment |
| --- | --- | --- |
| Bundle `schemaVersion`, artifact `schemaVersion`, `artifact`, manifest artifact names | Public aggregate | Project to the public generation, manifest, artifact, and analytical-version fields; never pass the private wrapper through. |
| Bundle artifact `file`, `sha256` | Public aggregate | Replace with the fixed public filename and hash of the projected public bytes. |
| `databaseState.canonicalSnapshotSha256`, `genreEvidenceSnapshotSha256`, `migrations[*].version/name/checksumSha256` | Private-only | Omit. Database fingerprints, migration state, and private-input lineage are not public snapshot metadata. |
| Analytical envelope `analysis`, `definition`, `eventCount`, `includedSources`, `metadataCoverage`, `presentationTimezone`, `unresolvedRate` | Public aggregate | Project allowlisted definitions and coverage into the public envelope/manifest. |
| Analytical envelope `asOf`, `dateRange.startInclusive`, `dateRange.endExclusive` | Public aggregate | Reduce to `asOfDate` (`YYYY-MM-DD`) and public month bounds (`YYYY-MM`); no time of day survives. |
| Analytical envelope `parameters` | Public aggregate | Project only the parameters required to explain the visible view. Exact UTC bounds, private IDs, and unsupported alternate metrics are omitted. |
| Analytical envelope `versions.analysis`, `parameterSchema`, `query` | Public aggregate | Rename into `analyticalVersions`. |
| Analytical envelope `versions.identityRules`, `reconciliationRules` | Private-only | Omit internal rule-lineage lists; their public effect is described in methodology and aggregate unresolved coverage. |
| Volume `metricLabel`, `totalValue`, `rows[].value/rollingValue/priorYearValue/yearOverYearAbsoluteChange/yearOverYearRate` | Public aggregate | Publish as the monthly `play_count` history artifact. |
| Volume `rows[].period` | Public aggregate | Publish only `YYYY-MM`; day and ISO-week rows are not public artifacts. |
| Volume parameters `metric`, `grain`, `rollingWindowPeriods`, `includeUnresolved` | Public aggregate | Fix to the reviewed monthly canonical-play-count view; disclose the accepted values. |
| Volume parameters `startInclusive`, `endExclusive` | Private-only | Do not pass through; the artifact month range is authoritative. |
| Volume `minimumDurationMs`, `play_count_at_least_ms`, and `listened_ms` | Private-only for v1 | The methodology may explain these scopes, but v1 data contains no duration or thresholded series. |
| Coverage `reportVersion`, `timezone`, `semantics` | Public aggregate | Project the public definition and timezone; omit source-layer implementation wording not needed by the reader. |
| Coverage `generatedAt` | Private-only | Replace with public candidate/report and publication dates at day granularity. |
| Coverage `inputFiles[*].source/sha256` | Private-only | Omit all private input hashes and file inventory. |
| Coverage `totals.evidenceOccurrences/accepted/rejected/nonMusic/canonicalEvents` | Public aggregate | `canonicalEvents` becomes common coverage; other lifecycle totals are omitted from v1 because they do not support a first-release journey. |
| Coverage `canonical.eventCount/bySourceBacking/unresolved/overlapByYear/merges` | Public aggregate | Publish event count, backing, unresolved rate, and yearly overlap. Explain merge semantics; omit detailed internal merge counters. |
| Coverage `sources[*].source/evidenceCount/byYear/observedRange/longGaps` | Public aggregate | Publish source name, yearly counts, month-reduced observed bounds, and month-reduced gap bounds. Omit the redundant all-time source total. |
| Coverage `sources[*].totals/duplicates/missingFields` | Private-only for v1 | Omit operational/rejection detail and source-field completeness from the public snapshot. |
| Coverage `archiveBaselineComparison` | Private-only | Omit the private-archive calibration baseline and deviations. |
| Artist era `intervals[*].artistId` | Private-only | Omit. It can never become a public slug or URL parameter. |
| Artist era `artistDisplayName` | Eligible artist detail | Publish only after the artist passes significance and result-limit rules. |
| Artist era interval `windowStart/windowEndExclusive`, `peak.windowStart` | Eligible artist detail | Reduce/validate as `YYYY-MM` public period labels. |
| Artist era interval `playCount/share/strength` | Eligible artist detail | Publish bounded aggregate interval values. |
| Artist era `evidence[*].components` and `peak.components` | Eligible artist detail | Publish the allowlisted count/share/rank/baseline/strength components; omit `isQualified`, which is implied by inclusion. |
| Artist-era parameter fields | Public aggregate | Publish in methodology/analytical versions so interval semantics remain inspectable. |
| Rediscovery `rediscoveries[*].entityId` | Private-only | Omit; it cannot be a public reference. |
| Rediscovery `entityDisplayName` and `scope` | Manually selected editorial detail | Artist identity may resolve to an eligible public slug. Private track identity is never projected automatically; an independently reviewed manual selected-track entry is the only source of a public track name. Scope is represented by story kind/detail rather than passed through. |
| Rediscovery `priorListenAt`, `returnStartedAt`, `relatedEra.windowStart/windowEndExclusive` | Manually selected editorial detail | Reduce to `YYYY-MM` period labels. No exact return or prior-listen instant is public. |
| Rediscovery `classification/gapDays/priorPlayCount/returnIntensity/persistence/persistencePlayCount/returnWindowComplete/relatedEra` | Manually selected editorial detail | Publish only for an approved story with its parameter and coverage qualification. |
| Rediscovery parameter fields | Public aggregate | Disclose only with the selected story evidence; no unreviewed candidate list is public. |
| Abandonment `artists[*].artistId` | Private-only | Omit; it cannot become a public reference. |
| Abandonment `artistDisplayName` | Manually selected editorial detail | Publish only in an approved story; link to an artist page only when the artist is separately eligible. |
| Abandonment `lastListenAt`, `lastActivePeriod.startAt/endAt` | Manually selected editorial detail | Reduce to `YYYY-MM` periods. |
| Abandonment `status/activePeriodCount/formerCadencePlayCount/formerCadencePlaysPer30Days/historicalPlayCount/lastActivePeriod.playCount/observationDays/confidence` | Manually selected editorial detail | Publish only for an approved story and preserve as-of, reversibility, right-censoring, and supersession wording. |
| Abandonment parameter fields | Public aggregate | Disclose only with the selected story evidence; no unreviewed candidate list is public. |
| Genre `provider/mode/taxonomyVersion/weightingLevel/contributionVersion/fetchAge/coverage` | Public aggregate | If P6-09 activates the artifact, publish `musicbrainz`, `raw`, taxonomy `null`, artist weighting, freshness date, and usable-event coverage. |
| Genre `intervals[*].genreId` | Private-only | Replace with a stable reviewed public genre slug; do not expose a provider/internal identifier. |
| Genre `genreLabel`, interval month bounds, contribution/share/strength/peak` | Public aggregate | Publish only in the experimental artifact after the sparse-group gate and result limits. |
| Genre interval window evidence and full raw tag/provider payloads | Private-only | Omit. The public lab cannot redistribute provider payloads or expose a tag evidence cache. |
| Authored `contentSchemaVersion`, `publicationStatus`, `title`, `summary`, structured `body`, `order`, `accessibilitySummary` | Manually selected editorial detail | Publish in the closed editorial/story content schemas. |
| Authored public route/period anchors and public data references | Manually selected editorial detail | Admit only the declared same-origin routes, optional public-slug fragments, reduced periods, or reviewed credential-free HTTPS links without query data; no private locator or ID. |
| Authored featured-artist reference | Eligible artist detail | Must resolve to an artist in the same approved snapshot. |
| Authored selected-track name/artist/story/slug | Manually selected editorial detail | The exact reviewed manual entry is authoritative and need not resolve to a private analytical candidate; at most one track is attached to a story. It cannot create track-level analytical evidence. |
| Publication `snapshotId`, generation/policy/schema versions, timezone, as-of/publication dates, artifact filenames/hashes, snapshot/report hashes, supersession, approval decision | Public aggregate | Publish in the public manifest. Approval has a decision and date but no username/account identifier. |
| Publication candidate diff counts, public slug lists, exact field allowlists, artifact hashes, added/removed/changed public slugs | Private review metadata | Retain in the ignored review report; it is safe but not a site data dependency. |

The following are forbidden regardless of where they appear: individual listening events; arrays or
objects named as event logs; private analytical-bundle passthrough; database, artist, entity, track,
genre, source, or provider entity IDs; source paths and filenames; input hashes; source or canonical
fingerprints; migration/database state; raw provider or rejected payloads; IP addresses; account
usernames; source user-agent strings; credentials, authorization values, keys, tokens, passwords, or
secrets; Spotify country; and Spotify platform/device context.

## Public selection and granularity policy

The executable version is `public-selection-policy-v2`.

### Dates

- Analytical instants, event-derived bounds, artist intervals, annotations, rediscovery evidence,
  and dormancy evidence publish only as calendar months (`YYYY-MM`) in the explicit snapshot
  timezone, normally `America/Chicago`.
- Coverage series publish by calendar year (`YYYY`); coverage ranges and long-gap bounds use months.
- `asOfDate`, candidate-report date, approval date, and `publicationDate` are operational metadata
  at day granularity (`YYYY-MM-DD`). They are not listening-event dates.
- No public schema has a UTC timestamp, epoch, day-grain listening row, exact prior listen, exact
  return instant, or exact last-listen instant.

### Artist eligibility and the long tail

An artist is eligible only when at least one already-qualified `artist-era-v1` interval has both:

- at least **24** qualifying-window plays; and
- peak strength of at least **0.75**.

The two gates avoid admitting a tiny but high-share interval or a larger weak interval. They are
defined against the stable aggregate interval contract, require no new private query, and are
covered at exact boundaries with synthetic tests. Eligible artists are ranked by best qualifying
interval play count descending, then strength descending, then stable public slug. At most **200**
artists are public. Each may expose at most **12** intervals and **48** aggregate evidence windows
per interval. Suppressed artist names, counts, and existence are never placed in client payloads,
search indexes, not-found behavior, or review output intended for the site.

Eligibility is a publication threshold, not a claim about musical worth. There is no editorial
override that creates an artist page. A manually selected story may name an otherwise ineligible
artist as editorial detail, but it cannot create a searchable artist record or route.

### Small and sparse groups

- The history artifact retains zero and small monthly canonical play counts because it contains no
  entity identity and month is the finest public grain. Empty history remains an explicit empty
  state rather than fabricated zeros.
- Source coverage is yearly. Source gap bounds are monthly, so they cannot encode an event.
- Artist groups use the significance gates above. No “other artists” count or suppressed-name list
  is published.
- A selected story may show small counts only because the complete evidence block and identity were
  manually approved together.
- If the genre lab is activated, an interval needs contribution of at least **24** and peak strength
  of at least **0.75**. Low overall/yearly usable-event coverage remains visible; it never becomes
  an `unknown` genre.

### Stable public slugs and bounded results

Public artist, story, annotation, selected-track, and optional genre slugs are explicitly assigned,
lowercase ASCII kebab-case values of at most 80 characters. They are not derived from an internal
ID. A slug is unique within its public namespace, remains stable across snapshots, is never reused
for a different object, and resolves only inside an approved snapshot. Renames change display text,
not the slug. Collision resolution is an editorial decision recorded before generation.

In addition to the artist limits, a snapshot contains at most 600 history months, 100 annotations,
40 featured artists, 40 stories, 100 genres, and 300 genre intervals. A story contains zero or one
selected track. The browser never receives the suppressed tail so filters cannot broaden these
sets.

### Selected tracks

Track identity is wholly manual, review-bound editorial detail. Each entry supplies exactly one
reviewed artist display name, track display name, story slug, and unique public track slug. It does
not contain a private selection key and does not resolve against the private analytical bundle.
Duplicate track identities, duplicate public track slugs, multiple tracks for one story, missing
story references, or an unreviewed track name fail generation.

A manual selected track is illustrative identity only. It does not establish that a private
track-scope rediscovery candidate exists and cannot supply gap, return, persistence, play-count,
timestamp, or other track-level analytical evidence. Any analytical evidence in the same story
must independently resolve to an allowlisted bundle-backed artist-level result and be labeled at
that scope. No track catalog, per-track series, play list, exact timestamp, event count sequence,
or fallback to private rediscovery output is permitted.

## Versioned public schemas

The executable closed schemas are:

- `public-manifest-v1` for candidate and approved manifest state;
- `public-artifact-v1` for `history.json`, `artists.json`, `editorial.json`, `stories.json`, and the
  optional all-or-nothing `genre-lab.json`;
- `public-review-report-v1` for the ignored human-review boundary;
- `public-snapshot-generator-v1` for generation behavior; and
- `public-selection-policy-v2` for date, selection, sparse-group, slug, and limit decisions.

Every artifact repeats its snapshot ID, schema/generation/selection versions, timezone, reduced
as-of date, candidate-time `publicationDate: null`, common coverage, and applicable analytical versions. Each analytical
artifact or selected story also carries the closed, allowlisted parameter values needed to explain
its visible result; private UTC bounds remain omitted. The manifest records the shared context plus
fixed filenames, SHA-256 hashes of exact artifact bytes, a deterministic snapshot hash,
review-report hash, superseded snapshot ID, publication policy, and approval state. A candidate has
`publicationDate: null` and no approval. An approved manifest has a publication date and an approval
record whose report hash exactly matches the reviewed report.

P6-04 preserves the exact reviewed artifact bytes during approval, so their candidate-time
`publicationDate: null` does not change. The approved manifest and `approval.json` are authoritative
for the approval/publication date. This keeps approval metadata from silently changing artifact
hashes after review.

The review report lists the reduced as-of date, common coverage, analytical versions, every
artifact filename and hash, exact executable field allowlist, record count, and proposed public
slug, plus additions, removals, changed artifacts, prior snapshot, and selection-policy change
status. The reviewer inspects that report and the exact staged artifact bytes. Approval binds their
hashes; it never causes regeneration.

The closed artifact shapes cannot express an event log: history accepts one strictly ordered row per
month; artist and genre data accept only bounded, chronologically valid interval aggregates; story
evidence accepts only reduced, chronologically consistent periods and aggregate counts; all unknown
keys are rejected; and `events`, internal IDs, exact timestamps, and private field names are
forbidden recursively. Counts, source backing, overlap, coverage sources, and applicable analytical
versions reconcile within each artifact before it is reviewable.

## Candidate, approval, supersession, withdrawal, and rollback workflow

1. **Generate:** P6-04 will read a verified private analytical bundle and separately reviewed
   authored/selection inputs. It will stage a complete candidate under the ignored
   `data/outputs/publication-candidates/<snapshot-id>/` directory without touching an approved
   snapshot.
2. **Validate and report:** schema validation, forbidden-field scanning, deterministic hashes, and
   a `public-review-report-v1` diff run before a candidate is reviewable. The report contains no
   rejected private payload, suppressed long-tail names, private ID, path, input hash, or source
   record.
3. **Review:** the owner compares the report and exact candidate bytes with the previous approved
   snapshot. Required review includes fields, entities/stories, ranges, versions, coverage,
   selection-policy changes, additions, removals, every manual selected-track identity, external
   links, asset/license records, and the visible privacy disclosure.
4. **Approve:** a separate explicit command records the approval decision/report hash and copies the
   already-reviewed bytes to `data/publication/approved/<snapshot-id>/`. It must fail if any byte or
   hash changed. Generation, import, sync, enrichment, analysis, and ordinary site builds cannot
   approve or publish.
5. **Commit:** only the approved directory, approval record, and the small active-snapshot pointer
   under `data/publication/` are intentionally committable. Private bundles, candidates, diffs,
   rejected staging, and local previews remain under ignored `data/outputs`.
6. **Supersede:** a new approved manifest names the prior snapshot. Public references must resolve
   within the active snapshot or follow an explicit authored supersession. A refresh never silently
   rewrites an older approved directory.
7. **Withdraw:** change the active pointer to another approved snapshot (or a no-snapshot state) and
   add a committed withdrawal record. Unknown, withdrawn, and unapproved slugs use identical
   not-found behavior. Git history is not an erasure mechanism; an actual privacy/secret incident
   requires disabling deployment and the separate incident-remediation process.
8. **Rollback:** repoint to and redeploy an earlier committed approved snapshot by hash. No private
   input, database, analytical regeneration, or network provider is needed.

P6-04 owns implementation and failure-atomicity tests for this workflow; P6-10 owns the protected
deployment and pointer behavior.

## Publication, licensing, and third-party policy

### Downloads

Version 1 permits **no downloadable data files**. The manifest requires `downloads: []`. Pages may
offer canonical share URLs, printing, and accessible HTML tables. Adding CSV, JSON, or other data
downloads requires a new selection-policy/schema version, a field-level review, and bounded
view-specific files; client-generated whole-snapshot or event-log export is never allowed.

### External links and requests

External links must be authored, credential-free HTTPS links without query data to reviewed
destinations, visibly identify the destination, and use safe opener/referrer behavior. They are
navigation, not embedded data access.
The built site makes same-origin requests only. There are no remote embeds, web beacons, API calls,
provider lookups, tag managers, runtime font requests, or other automatic third-party requests.
If the experimental genre lab ships, the static methodology may link to MusicBrainz and show the
required attribution, but the browser never requests MusicBrainz data.

### Artwork and licensing

No Spotify, Last.fm, MusicBrainz, or other third-party artist/album artwork is authorized by
default. Only project-owned work or an asset with documented redistributable license, attribution,
source, and review may be committed; its metadata and bytes must contain no private source data.
Absence of artwork is a valid design outcome. Provider raw-tag evidence is not redistributed.

### Fonts

The first release uses the system font stack and makes no font request. A later self-hosted font
requires committed license/attribution, reviewed subset files, and a contract change. Remote font
services are not permitted.

### Visitor analytics, storage, and privacy disclosure

Visitor analytics are **none**. The site sets no analytics cookies, fingerprint, tracking pixel,
local-storage identifier, or visitor account and sends no telemetry. Functional URL state needs no
storage. A new analytics proposal requires a new publication decision and cannot be enabled only by
deployment configuration.

Every release includes a visible privacy/publication disclosure, with a concise adjacent form and a
full methodology section, stating that this is one person's reduced and reviewed history; no
individual listening log or private archive is published; artist pages and track stories are
selected; counts and dates are aggregated/reduced; Spotify duration and genre coverage are partial;
the active snapshot's as-of/publication dates and versions; no visitor tracking; and a public contact
route for correction, licensing, or withdrawal requests. The contact route must not expose a private
email address in data artifacts or require a third-party embed.

## Alternatives, migration impact, and privacy implications

- Publishing the private analytical bundle was rejected because it contains the artist/track long
  tail, precise timestamps, internal IDs, database fingerprints, and operational metadata not
  needed by the site.
- Pure manual publication was rejected because field drift and stale analytical claims would not
  be testable. The narrow selected-track identity exception is manual because the stable private
  bundle intentionally has no track-scope candidate contract; it is prohibited from carrying
  analytical claims. Pure automatic publication was rejected because a passing schema cannot
  replace human review of names, stories, external links, licenses, and changed public meaning.
- Hash-derived or ID-derived slugs were rejected because they leak lineage and are hard to withdraw
  or keep stable across identity changes. Explicit public slugs make collisions and renames
  reviewable.
- Day-grain history and exact story instants were rejected because the narrative works at month
  grain and finer data makes reconstruction easier without adding essential meaning.
- A k-anonymity rule over one person's history would imply a population privacy guarantee that does
  not exist. The contract instead combines coarse time, identity eligibility, strict bounds, manual
  story selection, and review.

This task adds no dependency, command, database table, or migration. Future schema additions use a
new public contract version; threshold or limit changes use a new selection-policy version; changed
semantics use a new generation version. Approved v1 bytes remain immutable and rollback-safe.
