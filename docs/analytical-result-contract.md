# Analytical result contract

P4-01 defines the common JSON envelope for every analytical result. It is implemented in
`src/analytics/result.ts`; the current stable schema identifier is `analytical-result-v2`.

Each result contains:

- its analysis name and human-readable definition;
- an explicit UTC date range and as-of timestamp, or `null` for both when the selected population
  has no observable date range;
- the presentation IANA timezone and included source set;
- canonical event count, unresolved rate, and any relevant metadata-availability rates;
- validated parameter values;
- analysis, parameter-schema, SQL-query, identity-rule, and reconciliation-rule versions; and
- the analysis-specific `result` payload.

Analyses must derive the identity and reconciliation version lists from the canonical inputs they
actually query. A parameter validator is a TypeScript boundary owned by that analysis; its stable
`schemaVersion` is recorded in `versions.parameterSchema` alongside the accepted parameters. SQL
views or queries likewise receive a stable version identifier in `versions.query`. Changing either
semantic contract requires a new version rather than silently reinterpreting a previous result.

Use `createAnalyticalResult` to validate and normalize an envelope, and
`serializeAnalyticalResult` for JSON output. Serialization recursively sorts object keys, source
names, and rule-version lists, so equal analytical values yield equal bytes (with one trailing
newline). Object-key order uses locale-independent UTF-16 code-unit comparison, so it does not
vary with the host locale or ICU data. The contract accepts only canonical UTC timestamps, an explicit valid IANA timezone,
non-negative counts, rates from zero through one, and internally consistent metadata coverage.
Missing or malformed required envelope context is rejected with an `AnalyticalResultContractError`;
callers do not need to interpret JavaScript property-access failures. `dateRange` and `asOf` are
always present as a pair: both canonical UTC values when a range exists, or both `null` when it
does not.
Each metadata-coverage denominator is the result's canonical `eventCount`, so an availability rate
always describes the same population as the analytical result. Analyses that later need coverage
over a narrower population must define and disclose that population in a new contract version.

This contract is deliberately analytical-only. It does not expose raw evidence, source paths,
account data, sensitive source fields, or private payloads. The common envelope rejects excluded
source and credential field names recursively in parameters and result payloads, including common
snake-case, kebab-case, and camel-case spellings. Each analysis must additionally define an
allowlisted payload shape for its own result before publishing an output.

## Canonical analytical base

P4-02 provides `queryCanonicalAnalyticalBase` in `src/analytics/base.ts`. Its inspectable SQL
query (`canonical-analytical-base-v1`) returns one active canonical event per row, including
`current` and `unresolved` events but never superseded events. It aggregates source backing before
joining to the event, so a reconciled Spotify/Last.fm event remains one analytical event while
retaining source-count and source-coverage flags. `spotifyDurationMs` is derived only from Spotify
evidence; it is `null` for events without that evidence and must not estimate duration for
Last.fm-only history.

Calendar projections are calculated only after the caller passes an explicit IANA presentation
timezone. The base never reads the machine timezone and exposes local day, ISO week, month,
quarter, and year projections for later calendar-grain analyses.

## Listening volume

P4-03 provides `generateVolumeAnalysis` in `src/analytics/volume.ts` and the read-only
`analyze:volume` command. Its default `play_count` counts every current or unresolved canonical
track event once at the selected `day`, `iso_week`, `month`, `quarter`, or `year` grain. The
separately named `play_count_at_least_ms` is an optional Spotify-backed duration-thresholded
variant; its default threshold is 30,000 milliseconds and it never treats missing Last.fm duration
as a qualifying play. `listened_ms` sums Spotify-backed playback milliseconds only, once per
canonical event, and is always labeled Spotify-only.

```sh
pnpm analyze:volume
pnpm analyze:volume --json --grain month --metric listened_ms
pnpm analyze:volume --grain day --from 2024-02-01T00:00:00.000Z --to 2024-03-01T00:00:00.000Z --rolling-window-periods 7
```

`--from` and `--to` are paired canonical UTC instants. When supplied, every calendar period in
the requested range is emitted, including periods with zero value. Each row supplies a rolling
value over the selected number of periods and a same-calendar-period prior-year comparison when
one exists. The envelope includes canonical-event and Spotify-duration coverage, unresolved rate,
timezone, parameter values, and the versioned query/analysis contracts. No raw evidence or source
display values are emitted.

An unbounded selection with no canonical events returns an empty `rows` array and `null` for both
`dateRange` and `asOf`; it never fabricates a historical zero period. A bounded selection still
emits every requested period, including zero-value periods.
