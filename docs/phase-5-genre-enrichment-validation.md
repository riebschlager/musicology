# Phase 5 genre enrichment validation

**Assessment date:** 2026-08-09

**Presentation timezone:** `America/Chicago`

**Status:** experimental; not fit for an unqualified user-facing genre-era view

This P5-08 assessment used the ignored local archive database and emitted only aggregate counts.
No private source record, artist name, provider identifier, raw response, source path, or taxonomy
artifact was retained in this document. The combined content hash of `data/inputs` was unchanged
before and after the checks.

## Archive enrichment run

The database was migrated through migration 0015 and passed SQLite integrity, foreign-key, and
evidence validation checks. Enrichment then ran as one bounded batch followed by a full resumable
pass and one retry pass:

```sh
pnpm enrich:genres --json --limit 25
pnpm enrich:genres --json
pnpm enrich:genres --json
```

The bounded batch fetched 11 eligible artists and skipped 14 without one exact strong MusicBrainz
artist ID. The full pass resumed from those 11 cached snapshots, fetched the other 363 eligible
artists, and skipped the 13,364 artists without a unique exact ID. It initially exposed 12 rejected
artists: aggregate-only diagnosis found valid distinct provider tag spellings that shared one
matching normalization. Migration 0015 and its contract regression preserve those raw spellings;
the retry converted all 12 artists to usable evidence. A final no-change pass reported 374 cached,
0 fetched, and the same coverage. This demonstrated bounded operation, incremental persistence,
resume behavior, corrective migration of retained evidence, and complete stable cache reuse. The 24
earlier `malformed_response` attempts remain immutable historical snapshots, while no artist is
currently classified as failed.

| Current enrichment state | Artists | Canonical events |
| --- | ---: | ---: |
| Enriched with usable positive raw weights | 286 | 27,394 |
| Exact ID but no usable tags | 88 | 1,198 |
| Exact ID but latest lookup failed | 0 | 0 |
| No unique exact strong MusicBrainz ID | 13,364 | 92,789 |
| **Total** | **13,738** | **121,381** |

The 286 usable artists retained 2,195 raw-tag rows. All usable evidence was fresh under
the 180-day policy at assessment time. No curated taxonomy was installed, so this fitness decision
uses `genre-contribution-v2` raw mode with provider `musicbrainz`, taxonomy version `null`, and
weighting level `artist`. Curated output remains unavailable until a versioned
`genre-taxonomy-v1` artifact is reviewed and imported.

Overall usable event coverage was **22.57%** (27,394 of 121,381 events). For the deterministic top
200 artists by current-event count then canonical artist ID, 63 artists had usable evidence and
usable event coverage was **41.59%** (22,066 of 53,057 events). This is meaningful for pipeline
validation but not representative enough for an unqualified history-wide genre interpretation.

## Usable event coverage by year

The table counts current or unresolved canonical events exactly once and treats an event as usable
only when `genre-contribution-v2` produced a positive normalized raw contribution. Calendar years
use the explicit `America/Chicago` presentation timezone.

| Year | Canonical events | Usable events | Usable coverage |
| --- | ---: | ---: | ---: |
| 2005 | 3,532 | 247 | 6.99% |
| 2006 | 2,510 | 330 | 13.15% |
| 2007 | 6,790 | 1,037 | 15.27% |
| 2008 | 8,462 | 1,453 | 17.17% |
| 2009 | 6,475 | 812 | 12.54% |
| 2010 | 5,166 | 1,236 | 23.93% |
| 2011 | 8,627 | 2,200 | 25.50% |
| 2012 | 4,072 | 1,305 | 32.05% |
| 2013 | 3,604 | 686 | 19.03% |
| 2014 | 4,201 | 936 | 22.28% |
| 2015 | 4,727 | 1,546 | 32.71% |
| 2016 | 9,390 | 1,918 | 20.43% |
| 2017 | 2,457 | 764 | 31.09% |
| 2018 | 3,741 | 901 | 24.08% |
| 2019 | 4,865 | 1,217 | 25.02% |
| 2020 | 5,539 | 1,320 | 23.83% |
| 2021 | 4,968 | 1,052 | 21.18% |
| 2022 | 3,951 | 848 | 21.46% |
| 2023 | 6,174 | 1,480 | 23.97% |
| 2024 | 9,807 | 2,093 | 21.34% |
| 2025 | 9,152 | 2,436 | 26.62% |
| 2026 | 3,171 | 1,577 | 49.73% |

## Fitness decision and evidence gaps

Genre-era analytics remain **experimental** for Phase 6. A presentation may expose them only behind
an explicit experimental treatment that shows raw mode, provider, nullable taxonomy version,
artist-level weighting, freshness reference, and usable-event coverage. It must not imply that the
intervals describe the complete listening history.

The limiting evidence and known biases are:

- exact-ID-only enrichment excludes 97.28% of current artists and disproportionately favors the
  better-identified, more-played cohort;
- annual usable coverage varies from 6.99% to 49.73%, so apparent rises and fades can reflect
  metadata availability as well as listening behavior;
- MusicBrainz tags are community-maintained, provider-relative, and can be sparse, noisy, current
  rather than historically contemporaneous, or absent;
- artist-level weighting assigns one current tag distribution to every track and historical event
  for that artist, so it cannot represent release-specific or time-varying genre evidence;
- no curated taxonomy has been reviewed against the archive, so only raw-tag experimental results
  are currently reproducible.

The next evidence needed for a fit-for-use decision is a privacy-reviewed increase in exact
MusicBrainz identity coverage, a curated taxonomy artifact, and a repeat of this same
year/top-cohort coverage assessment. A fallback provider requires a new
provider/licensing decision record; it is not authorized by the current Phase 5 decision.

Core history was not changed by this assessment. Genre evidence remains optional and independently
refreshable, raw snapshots remain append-only, taxonomy decisions remain separately versioned, and
non-genre ingestion and analytics do not depend on provider availability.
