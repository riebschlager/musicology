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
record as `primary` evidence. Exact duplicate source rows intentionally remain separate initial
events until P2-04 collapses them at the event layer while retaining every source link.
