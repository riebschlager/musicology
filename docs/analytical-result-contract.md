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

## Artist-era components

P4-04 fixes the versioned artist-era parameter and component contract in
`src/analytics/artist-era.ts`. P4-05 will calculate calendar windows and assemble intervals from
this contract; it must not silently reinterpret a parameter or component below.

Windows are calendar-aligned periods in the explicit presentation timezone. Every cadence is
anchored at January 1970: starting at that month, each window spans exactly
`windowSizeMonths` consecutive calendar months. This supplies a continuous, reproducible cadence
for every supported size and avoids a short year-end window. The default three-month window is
therefore aligned to January/April/July/October. For example, with a five-month window, February
2026 belongs to the window beginning November 2025 and June 2026 belongs to the window beginning
April 2026. A rolling value covers the current window and the three preceding windows
(`rollingWindowCount: 4`), so the default describes the trailing twelve calendar months. Missing
windows inside observed history contribute zero plays. The equal-length earlier baseline is the
immediately preceding, non-overlapping rolling span; it is `null`, rather than zero, when it is not
observable.

The defaults below were inspected against deterministic synthetic histories: two total plays with
a 100% share do not qualify, while the exact threshold boundary does. They favor a readable
year-scale era while retaining artists with a moderate decline. All values are configurable within
the supported ranges below; the caps keep each calendar cadence and its derived rolling analysis
bounded. Accepted values will be included in the P4-05 result envelope.

| Parameter | Default | Supported range | Meaning |
| --- | ---: | --- | --- |
| `windowSizeMonths` | 3 | Positive integer, at most 12 | Calendar months per aligned activity window. |
| `rollingWindowCount` | 4 | Positive integer, at most 24 | Consecutive windows in each trailing rolling count. |
| `minimumWindowPlayCount` | 3 | Positive safe integer | Plays required in the current window. |
| `minimumRollingPlayCount` | 12 | Positive safe integer | Plays required across the rolling window. |
| `minimumListeningShare` | 0.02 | Finite number greater than 0 and at most 1 | Artist's rolling plays divided by all canonical rolling plays. |
| `maximumRank` | 20 | Positive integer, at most 100,000 | Dense rank by rolling plays; ties receive the same rank. |
| `minimumConsecutiveActiveWindows` | 2 | Positive integer, at most 100 | Adjacent current windows meeting the two play-count gates. |
| `minimumEarlierBaselineChange` | -12 | Safe integer | Minimum `rollingPlayCount - earlierBaselineRollingPlayCount` when a baseline is observable. |

For each artist/window, P4-05 must preserve `windowPlayCount`, `rollingPlayCount`,
`listeningShare`, `rank`, `consecutiveActiveWindows`, `earlierBaselineRollingPlayCount`, and
`earlierBaselineChange`. A window qualifies only when the two count gates, share, rank,
consecutive-activity, and (when known) earlier-baseline gates all pass. An unavailable earlier
baseline is reported as `null` and does not become invented zero activity or fail that one gate.

`strength` is an explainable 0–1 mean of known capped component ratios: current-window plays,
rolling plays, share, inverse rank, consecutive activity, and, when available, baseline change.
Each count/share/activity ratio caps at its corresponding minimum; inverse rank is
`(maximumRank + 1 - rank) / maximumRank`, capped to 0–1; baseline change is
`(earlierBaselineChange - minimumEarlierBaselineChange) / minimumRollingPlayCount`, capped to
0–1. A missing baseline is omitted from this mean, not scored as zero.

For reproducible sensitivity examples, the default evaluator produces the following results:

| Synthetic window | Relevant values | Result |
| --- | --- | --- |
| Low-volume dominance | 2 current/rolling plays, 100% share, rank 1, 2 consecutive windows, baseline 0 | Does not qualify because both absolute play-count gates fail. |
| Exact boundary | 3 current plays, 12 rolling, 2% share, rank 20, 2 consecutive, earlier baseline 24 | Qualifies: its baseline change is exactly -12 and its strength is `0.6749999999999999`. |
| New, observable activity | 4 current plays, 16 rolling, 4% share, rank 5, 2 consecutive, unavailable baseline | Qualifies without inventing earlier activity; baseline change remains `null` and strength is `0.96`. |

An eventual interval has an inclusive first qualifying window start and exclusive last qualifying
window end; its peak is the qualifying window with greatest strength (then greatest rolling count,
then earliest start). Its `playCount` is the sum of current-window plays, its `share` is the mean
window share, and its evidence contains the component values and baseline availability for every
qualifying window. This preserves the explanation for a result without emitting source evidence or
artist/track payloads beyond the canonical analytical identity required by P4-05.

## Artist-era analysis

P4-05 provides `generateArtistEraAnalysis` and the read-only `analyze:artist-eras` command. It
uses the canonical analytical base, so each current or unresolved canonical event is counted once
regardless of whether it has Spotify, Last.fm, or both sources. The result includes all accepted
artist-era parameters, canonical event count, unresolved rate, explicit timezone, source-backing
coverage, input rule versions, and an `intervals` payload.

Each interval identifies the canonical artist, its inclusive `windowStart` and exclusive
`windowEndExclusive` calendar-month labels, total current-window `playCount`, mean `share`, peak
`strength`, and peak window. Its `evidence` array retains every qualifying window's full P4-04
components. Windows are sorted by their aligned start; intervals are deterministically ordered by
start then artist identity. Artists with no qualifying window are omitted rather than described as
having a negative or absent era.

```sh
pnpm analyze:artist-eras
pnpm analyze:artist-eras --json --window-size-months 1 --rolling-window-count 2
pnpm analyze:artist-eras --minimum-window-play-count 5 --minimum-listening-share 0.03
```

## Rediscovery analysis

P4-06 provides `generateRediscoveryAnalysis` and the read-only `analyze:rediscovery` command.
A rediscovery is an artist or track return after an exact UTC-time absence of at least
`absenceThresholdDays`, provided it has at least `minimumPriorPlayCount` earlier canonical plays.
The default threshold is 180 days; 90- and 365-day scenarios are supported explicitly through the
same positive-integer parameter (up to 3,650 days). The default scope is `artist`; `track` is also
supported. The analysis uses only current and unresolved canonical events, so a reconciled
Spotify/Last.fm event is counted once.

`returnIntensity` is the entity's play count from the return instant through the exclusive
`returnWindowDays` boundary (default: 30 days). `persistencePlayCount` is the count in the following
exclusive `persistenceWindowDays` boundary (default: 90 days). A completed persistence window with
at least `minimumPersistencePlayCount` (default: 2) is a `sustained_rediscovery`; a completed
window below that threshold is a `one_off_return`. If the history does not extend through that
boundary, persistence is `open` and the otherwise provisional one-off classification remains
explicitly marked rather than being treated as observed non-persistence.

An artist return is classified `return_beginning_new_era` when an artist-era interval begins in the
return/persistence observation horizon. The related interval's calendar bounds are included. The
result never exposes source rows, paths, raw timestamps beyond aggregate return/prior instants, or
private source fields. Each record includes its prior listen, prior count, exact gap length, return
intensity, persistence state/count, related era, scope, and the complete parameter envelope.

```sh
pnpm analyze:rediscovery
pnpm analyze:rediscovery --json --absence-threshold-days 90
pnpm analyze:rediscovery --scope track --absence-threshold-days 365 --minimum-prior-play-count 3
```
