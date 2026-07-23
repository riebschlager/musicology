# Phase 4 analytics validation and interpretation

This document records the aggregate, privacy-safe outcome of project-plan task P4-09. It is a
validation record, not a substitute for the analytical result envelopes or their tests. It contains
no source records, display values, input paths, private filenames, account identifiers, raw
payloads, credentials, or generated outputs.

## Reproducible validation workflow

Run against an existing, fully migrated local database. Every command is read-only with respect to
the database except `export:analytics`, which writes the ignored derived bundle under
`data/outputs`. `validate` also reads each registered immutable evidence file to verify its bytes
against the stored content hash, so the local evidence inputs must be available for that step.

```sh
pnpm db:status
pnpm validate
pnpm report:coverage
pnpm benchmark:analytics --json
pnpm export:analytics
pnpm export:analytics --check
```

`benchmark:analytics` runs volume, artist eras, rediscovery, and abandonment on one read-only
connection. It verifies that each envelope's `eventCount` equals the aggregate coverage report's
canonical-event count and reports only elapsed milliseconds and counts. Timings are observational:
compare like-for-like local runs, not different machines or cold/warm-cache runs as an absolute
performance guarantee.

## Analytical contracts and interpretation

Every analysis emits the versioned `analytical-result-v2` envelope defined in
[`analytical-result-contract.md`](analytical-result-contract.md). It declares the definition,
parameters, timezone, as-of value, source coverage, unresolved rate, rule/query versions, and
metadata coverage. The versioned web-layer representation is documented in
[`analytical-exports.md`](analytical-exports.md).

| Analysis | What it measures | Interpretation caution |
| --- | --- | --- |
| Listening volume | Canonical track-event count by calendar grain; separately named Spotify-backed duration and thresholded-count metrics | `play_count` is full canonical history, while `listened_ms` and thresholded metrics omit events without Spotify duration. Do not compare those metrics as though they share a denominator. |
| Artist eras | Consecutive calendar windows that qualify under explicit activity, share, rank, and change thresholds | An interval is a parameterized signal, not an objective genre, preference, or life-period boundary. Sparse windows can make rank/share volatile. |
| Rediscovery | A qualifying artist or track return after a configured UTC-day absence and prior activity | A source gap can look like an absence. Treat one-off returns, open persistence windows, and era links as evidence qualified by the displayed parameters. |
| Abandonment | A time-bounded `dormant` or `likely_abandoned_as_of` observation for historically important artists with former cadence | It is never a permanent fact. The recent edge is right-censored, and a later listen changes a later as-of conclusion without rewriting historical results. |

The CLI syntax, defaults, and available filters are documented in
[`configuration-and-cli.md`](configuration-and-cli.md). Use `--json` for a stable automation
contract; human output is intentionally concise and should not be parsed.

## Archive review — 2026-07-23

The local archive passed migration status and evidence validation with SQLite integrity and
foreign-key checks. It contained 123,369 source-evidence occurrences and 120,254 current or
unresolved canonical events. The four analyses each reported the same 120,254-event canonical
population. Coverage reported 4,440 unresolved canonical events, 2,724 events backed by both
sources, and Spotify duration evidence for 60,640 canonical events. These are aggregate snapshot
counts and will change after imports, synchronization, reconciliation, or rules change.

The coverage review confirmed the expected interpretation constraints:

- Early history is Last.fm-only and visibly sparse in places; low-volume years and intervals must
  not be interpreted as complete listening absence.
- The known 2017–2024 Last.fm gap remains a source-coverage gap, even though Spotify supplies
  evidence in that time span. Cross-source comparisons and apparent returns across that interval
  require the source-coverage fields in the envelope.
- Overlap years include both single-source and reconciled events. Canonical counts avoid
  double-counting events backed by both sources, but source-specific coverage remains material.
- The most recent observation is right-censored. Recent dormant outcomes are not sufficiently
  observed to support a permanent abandonment claim, and current rediscovery persistence can be
  open.
- Spotify-backed duration covers only part of canonical history. Duration, completion, skip, and
  duration-thresholded counts therefore cannot stand in for full-history play count.

Representative warm local runs completed volume in about 1.2 seconds, artist eras in 6.0 seconds,
rediscovery in 7.3 seconds, and abandonment in 1.2 seconds. Generating and verifying the complete
five-artifact analytical bundle each completed in under 18 seconds. These results are acceptable
for the current local CLI workflow; rerun `benchmark:analytics` after analytical query changes and
investigate material regressions on the same machine and database state.
