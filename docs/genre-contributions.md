# Genre contributions

P5-06 defines `genre-contribution-v1`, a query-layer contract that translates optional artist
evidence into fractional canonical-event contributions. It does not persist assignments, modify
provider snapshots, or create genre-era intervals; P5-07 will consume this contract.
Each result reads its taxonomy, evidence, freshness, and canonical events from one deferred SQLite
snapshot.

`generateGenreContributions` has two explicit modes:

- `raw` uses positive MusicBrainz raw-tag vote weights only when the latest non-failure snapshot
  for the artist's one exact strong MusicBrainz identifier is successful. A newer negative result
  therefore leaves the event missing rather than reviving older tags.
- `curated` requires an installed immutable taxonomy version. It applies that version's mappings,
  excludes `ignore`, combines mapped raw weights by target category, and then normalizes them.

The evidence is explicitly `artist` level. Every current or unresolved canonical event for an
artist with usable positive weights receives the same UTF-16 code-unit-sorted genre distribution.
Weights are normalized per event, rounded to twelve decimal places, and the final stable genre
receives the rounded residual, so each usable event contributes exactly `1`. There is no
track-level inference.

An event with no successful matching snapshot, only zero weights, or no retained curated mapping
is missing metadata—not an `unknown` genre. `coverage` therefore provides total, usable, and
missing artist/event denominators. `freshness` splits usable evidence with the documented
180-day refresh threshold (configurable for deterministic callers). Results also always identify
the fixed provider, raw/curated mode, nullable taxonomy version, and weighting level.
