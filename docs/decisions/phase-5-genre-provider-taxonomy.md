# Phase 5 genre provider and taxonomy decision

**Decision date:** 2026-07-23

**Status:** accepted for P5-02 through P5-07 implementation

## Decision

Use the MusicBrainz Web Service as the only initial genre-evidence provider. The first
adapter will fetch an artist only when the canonical artist already has a
`musicbrainz_artist_id`; it will request both the provider's raw tags and its recognized
genres. No name search, Spotify lookup, or inferred provider identity is authorized by
this decision.

Use a **hybrid taxonomy**:

1. preserve every provider raw tag and its provider vote count as evidence;
2. retain the provider's recognized-genre indication separately from its raw tag text;
3. apply a separate, versioned curated mapping only when producing an analytical genre
   category; and
4. leave unmapped, ignored, and ambiguous tags visible in evidence coverage rather than
   treating them as an analytical genre.

MusicBrainz vote counts are provider-relative weights, not probabilities, confidence
scores, or listening-event weights. P5-06 must define any later normalization explicitly.

## Candidate comparison

| Candidate | Licensing and durable local cache | Access, limits, and identity | Tag quality and freshness | Decision |
| --- | --- | --- | --- | --- |
| MusicBrainz Web Service | Core data is CC0; its supplementary data is CC BY-NC-SA. Store the provider license class, attribution, fetch instant, and unmodified raw tag text with every snapshot. Do not commit fetched evidence or redistribute it in generated exports unless the applicable license and attribution are satisfied. | No credential is required for read-only lookup. Existing `musicbrainz_artist_id` identifiers provide an exact key. The service documents an average per-IP limit of one request per second and asks clients to use a meaningful User-Agent. | Artist lookups support `tags` and `genres`; tag counts are available as a provider weight. Community-maintained tags can be sparse, noisy, or change. | **Selected.** It is the smallest provider set that has an existing strong identity key, no secret, bounded requests, and independently refreshable snapshots. |
| Last.fm artist top tags | Last.fm API use is governed by its non-commercial API terms; a durable, redistributable cache policy is less suitable for the project's first evidence store. | Requires a Last.fm API key even for public methods. Artist lookups can use names, which would send source-derived text when an MBID is unavailable. | Community tags have useful weights but their semantics and API availability are provider-controlled. | Not selected. Reconsider only as a separately licensed, credentialed fallback after MusicBrainz coverage is measured. |
| Spotify Web API artist metadata | Spotify developer terms limit local caching of Spotify Content to temporary operational use, which conflicts with reproducible evidence snapshots. | Requires authorization and Spotify catalog identifiers; no artist identifier is currently persisted from source evidence. | Catalog coverage is strong for Spotify-backed material, but it does not cover the full local history independently. | Rejected for durable enrichment. |
| Discogs API | Discogs describes part of its API content as restricted and says content may not be displayed when older than six hours; this conflicts with a durable, reproducible local snapshot. | Token/account handling and provider-specific attribution would be required. | Genres/styles are useful but release-oriented and can introduce release-to-artist inference. | Rejected for the initial provider set. |

Sources consulted on 2026-07-23: [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API),
[MusicBrainz rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting),
[MusicBrainz data licensing](https://musicbrainz.org/doc/About/Data_License),
[Last.fm API](https://www.last.fm/api), [Spotify Developer Terms](https://developer.spotify.com/terms),
and [Discogs API Terms](https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use).
Terms and provider behavior must be rechecked before enabling a new provider or publishing
provider-derived data.

## Reproducible aggregate sampling

Before P5-03 implementation, run the following read-only query against the current,
fully migrated local database. It intentionally returns only aggregate counts: no artist
names, identifiers, source rows, or listening timestamps. The query defines the eligible
population and a deterministic top-200 candidate cohort (descending current event count,
then canonical artist ID). Save only its aggregate result in a local, ignored assessment
note; never commit a private database or the candidate rows.

The query was run read-only against the current local database on 2026-07-23 using the
repository's Node 24 runtime. The privacy-reviewed aggregate result was:

| Population | Artists | Current/unresolved events | Artists with an exact MusicBrainz ID | Events backed by those artists |
| --- | ---: | ---: | ---: | ---: |
| All current artists | 13,738 | 121,381 | 374 | 28,592 |
| Deterministic top 200 | 200 | 53,057 | 64 | 22,199 |

This establishes that an exact-ID-only provider can cover a meaningful share of heavily
listened events while leaving most artists unenriched. It is sufficient to validate the
small, privacy-preserving first provider, not to claim that genre-era coverage is fit for
user-facing interpretation. P5-04 and P5-08 must report the resulting evidence coverage
and reassess a fallback provider only with a new decision record.

```sql
WITH current_artist_events AS (
  SELECT track.artist_id, COUNT(*) AS event_count
    FROM listening_event AS event
    JOIN track ON track.id = event.track_id
   WHERE event.event_status IN ('current', 'unresolved')
   GROUP BY track.artist_id
),
artist_population AS (
  SELECT events.artist_id,
         events.event_count,
         EXISTS (
           SELECT 1
            FROM music_identifier AS identifier
            WHERE identifier.entity_id = events.artist_id
              AND identifier.namespace = 'musicbrainz_artist_id'
              AND identifier.is_strong = 1
         ) AS has_musicbrainz_artist_id
    FROM current_artist_events AS events
),
deterministic_cohort AS (
  SELECT artist_id, event_count, has_musicbrainz_artist_id
    FROM artist_population
   ORDER BY event_count DESC, artist_id ASC
   LIMIT 200
)
SELECT 'all_current_artists' AS population,
       COUNT(*) AS artist_count,
       COALESCE(SUM(event_count), 0) AS event_count,
       COALESCE(SUM(has_musicbrainz_artist_id), 0) AS eligible_artist_count,
       COALESCE(SUM(CASE WHEN has_musicbrainz_artist_id = 1 THEN event_count ELSE 0 END), 0)
         AS eligible_event_count
  FROM artist_population
UNION ALL
SELECT 'top_200_by_current_event_count_then_artist_id',
       COUNT(*),
       COALESCE(SUM(event_count), 0),
       COALESCE(SUM(has_musicbrainz_artist_id), 0),
       COALESCE(SUM(CASE WHEN has_musicbrainz_artist_id = 1 THEN event_count ELSE 0 END), 0)
  FROM deterministic_cohort;
```

For each eligible cohort artist, P5-03 will request a single lookup only from its strong,
exact MBID at no more than one request per second, record only aggregate outcomes by `tags
present`, `no tags`, `not found`, `malformed`, and `temporary failure`, and compare eligible
artist and event coverage before deciding whether a fallback provider is warranted. The raw
provider response is not an assessment artifact and must not be logged.

## Refresh and privacy policy

- P5-03 will use a 180-day default refresh age for successful and no-tag snapshots. A
  failure is retryable and must not replace a successful snapshot. This is intentionally
  conservative because MusicBrainz discourages polling for changes.
- Refresh is explicit or bounded/resumable. It is independent of ingestion,
  reconciliation, and non-genre analytics; a provider outage cannot block them.
- The selected read-only request requires **no credential, token, account name, or API
  key**. P5-03 therefore adds no environment variable or secret configuration. Its fixed
  request configuration is:
  - endpoint template:
    `https://musicbrainz.org/ws/2/artist/{musicbrainz_artist_id}?fmt=json&inc=genres+tags`;
  - response format: JSON;
  - include parameters: `genres` and `tags`; and
  - `User-Agent`: `musicology/0.0.0 (https://github.com/riebschlager/musicology)`.
  Future releases update only the version component of this User-Agent; changes to the
  endpoint, included data, or contact URL require a new provider decision.
- Exact MusicBrainz IDs are sent to the provider. No listening timestamps, event counts,
  source paths, source-account values, Spotify country/platform data, raw rejected
  payloads, or private API configuration are sent or stored.
- Provider evidence is optional. Artists without an eligible ID, a provider result, or a
  curated mapping remain unenriched; unknown is never converted to a genre.

## Alternatives and deferred work

Raw-tag-only analysis would preserve maximum provider detail but cannot consistently group
synonyms, styles, and non-genre community labels. Curated-taxonomy-only storage would lose
the provider evidence needed to revisit those decisions. The hybrid approach preserves both
layers and defers the portable mapping artifact, mapping version, and category hierarchy to
P5-05 as planned.

This decision does not add a database migration, enrichment command, client, credential,
or provider data. The P5-02 evidence contract must encode snapshot lineage, provider
license/attribution, raw vote weight, fetch age, cache state, and error boundaries before
any network request is implemented.
