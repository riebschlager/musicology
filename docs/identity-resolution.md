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
