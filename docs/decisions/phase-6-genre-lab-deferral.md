# Phase 6 experimental genre-lab deferral

**Task:** P6-09  
**Decision date:** 2026-08-15  
**Status:** accepted; deferred from the initial release

## Decision

Do not ship the experimental genre lab in the initial public microsite. The release has no
`/lab/genres/` route, navigation entry, placeholder page, or `genre-lab.json` payload. Candidate and
approved public manifests keep `artifacts.genreLab` null.

Keep the local Phase 5 genre evidence and analysis pipeline intact and independently refreshable.
The closed optional public schema may remain as a dormant boundary, but its presence does not
authorize generation, approval, or publication of genre data. Activation requires a new explicit
decision and cannot occur implicitly during snapshot generation or deployment.

## Evidence and rationale

The P5-08 archive assessment remains **experimental; not fit for an unqualified user-facing
genre-era view**:

- only 22.57% of canonical events had usable genre evidence overall;
- usable coverage varied from 6.99% to 49.73% by year, so apparent genre changes could reflect
  metadata availability rather than listening behavior;
- exact-ID-only enrichment excluded 97.28% of current artists and favored better-identified,
  more-played artists;
- the reproducible output uses current MusicBrainz raw tags with artist-level weighting and no
  reviewed curated taxonomy, so it cannot model release-specific or historically changing genre;
  and
- provider tags may be sparse, noisy, or current rather than historically contemporaneous.

An experimental treatment could disclose these limitations, but it would add a secondary route and
publication surface without strengthening the first-release narrative. Deferral keeps the release
focused on the better-supported long view, coverage, artist eras, and curated stories while avoiding
any implication that partial genre enrichment describes the complete history.

## Initial-release consequences

- P6-10 deployment and P6-11 verification treat absence of the route and payload as the intended
  result, not an incomplete feature.
- The public snapshot pipeline continues to emit only `history.json`, `artists.json`,
  `editorial.json`, and `stories.json`.
- Methodology and disclosure copy may state that genre evidence is not included, but must not expose
  provider-derived genre labels, intervals, or payloads.
- No Phase 5 evidence, analytical contract, migration, or local command is removed or weakened by
  this publication decision.

## Gate for reconsideration

A future task may propose activation only after all of the following are available:

1. a privacy-reviewed improvement in exact MusicBrainz identity coverage;
2. a reviewed, versioned curated taxonomy artifact imported through the existing taxonomy boundary;
3. a repeat of the P5-08 overall, yearly, and important-cohort coverage assessment demonstrating
   that the intended public snapshot can support an honest, useful genre view; and
4. a new explicit publication decision covering the route, snapshot artifact, disclosures,
   licensing/attribution, accessibility, privacy, and tests.

If a fallback provider is proposed, it also requires a separate provider and licensing decision
before evidence is fetched or published. Any later activation remains all-or-nothing: the route and
data ship together under the full disclosure contract, or neither ships.
