# Identity resolution

P2-02 defines `identity-resolution-v1`. It processes unrepresented Spotify evidence and Last.fm
occurrences transactionally, retaining source display text in the evidence tables and storing only
versioned matching aliases separately. Each interpretation persists both the
`identity-resolution-v1` rule version and matching-normalization version. Resolution priority is a
trusted strong identifier, then a known alias, then one unambiguous artist/track/release composite,
then a newly created unresolved identity. Manual aliases already stored in `artist_alias` participate
before source aliases; portable manual-decision import remains P2-09 work.

Spotify track URIs and Last.fm MusicBrainz identifiers are trusted strong identifiers. If a strong
track or artist result disagrees with an otherwise eligible alias/composite, the resolver records an
`identity_resolution_conflict` and keeps the entities separate. An absent album yields a `NULL`
release interpretation—no placeholder release is invented. Re-running after all current evidence is
resolved is a no-op.

P2-03 adds `canonical-event-v1`, which materializes one initial event for every resolved source
occurrence. Spotify events retain their observed stop and duration as a `derived_start` interval;
Last.fm scrobbles are `observed_start` instants with no inferred duration. Short and skipped Spotify
plays are retained. A `new_unresolved` identity resolution creates an event with `event_status =
'unresolved'`, so it remains visible rather than being dropped. Each event is linked to its source
record as `primary` evidence.

P2-04 then collapses only exact within-source equivalents at the event layer. Spotify rows sharing
the complete approved source fingerprint link to the lowest-ID initial event, with subsequent rows
recorded as `exact_duplicate`; their now-unlinked events become `superseded`. Last.fm occurrences
that already share one fingerprint-unique `lastfm_scrobble_source` payload follow the same rule,
so a future API occurrence can reuse the export event without creating another canonical listen.
No source record or source-specific evidence row is deleted. Same-time Spotify records with
different approved fields have different fingerprints and remain separate events.

P2-05 defines `cross-source-candidate-v1`. It stores unscored Spotify/Last.fm source pairs in
`cross_source_candidate_generation`, separately from the scored `reconciliation_candidate` layer
introduced by P2-06. A pair must use a primary, non-superseded source interpretation, match within
a configurable 0–120-second window (30 seconds by default) measured from Spotify's derived start,
and share either a resolved track identity or normalized artist-and-track aliases. Indexed one-minute
time blocks bound the join before the exact window check. Each stored pair records whether entry was
through `shared_track_identity` or `matching_normalized_artist_track`, along with the generation rule
version. Generation is idempotent and does not itself merge events or calculate match scores.

P2-06 defines `cross-source-match-feature-v1`. Its deterministic feature pass consumes only those
generated pairs and creates pending `reconciliation_candidate` rows; it never changes events,
evidence links, or candidate decisions. Each row stores the signed Last.fm-minus-Spotify-derived
start delta, identity/text/album agreement, duration plausibility, neighbor ordering, ambiguity,
competitor clarity, and short-play signal separately from `total_confidence`. Higher agreement,
duration plausibility, ordering, competitor clarity, and short-play values favor a match; lower
absolute time deltas favor a match. `ambiguity_score` is the inverse: 0 means no competing pair and
higher values mean more ambiguity. Missing Last.fm recording identifiers and missing albums are
stored as NULL and are omitted from the aggregate denominator, never interpreted as disagreement.
Neighbor ordering is likewise NULL when either source timestamp is tied, because no chronology can
be inferred from equal instants.
An unchanged rerun is a no-op. If later candidate generation adds a competing or nearer pair, the
pass refreshes the contextual features of still-pending rows under the same feature-rule version;
resolved rows remain auditable snapshots for the decision layer.

The aggregate is a deterministic, normalized weighted mean of available feature values: identifier
agreement (25%), artist (15%), track (20%), album (10%), time closeness (15%), duration plausibility
(5%), neighbor order (5%), competitor clarity (5%), and short-play signal (5%). Its direction is
higher-is-more-compatible, but it is not a merge policy: P2-07 calibrates thresholds and hard
conflict rules before P2-08 can act on it. A Spotify play shorter than 30 seconds, or marked
skipped, has a short-play score of 0; otherwise it has 1. Duration plausibility decreases linearly
as timestamp distance approaches the larger of 30 seconds or the observed Spotify play duration.

P2-07 defines `cross-source-decision-policy-v1`, which consumes only
`cross-source-match-feature-v1`. Its policy artifact keeps the feature version, thresholds, and
rationale together: confidence of at least 0.95 is eligible for automatic acceptance; 0.70 through
0.949999 is review; lower confidence is ignored. A compatible strong identifier disagreement and
any competing generated candidate override those bands to review, so neither case can auto-merge.
Changing feature definitions, a threshold, a hard rule, or the rationale requires a new decision
policy version.

Use `pnpm export:reconciliation-calibration` to create a deterministic, stratified local sample in
`data/outputs/reconciliation-calibration-sample.json`; candidates within each stratum are selected
by a stable hash ranking rather than ingestion order, and `--per-stratum` controls the 1–1000 sample
limit per policy stratum. The JSON contains candidate and source-record IDs plus numeric feature
values and empty labels, but no display text, timestamps, paths, hashes, accounts, raw records, or
excluded fields. It is ignored by Git. Label the local sample and retain the resulting aggregate
calibration rationale without committing any private candidate export. P2-08 will apply this policy;
this task does not mutate candidate states or canonical events.
