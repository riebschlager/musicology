# Phase 3 live Last.fm synchronization verification

This document records the aggregate, privacy-safe outcome of project-plan task P3-08. It contains
no credentials, account identifiers, request URLs, source rows, display values, API payloads,
private input filenames, input hashes, or generated database content.

## Run context

- Completed: 2026-07-22
- Runtime: Node.js 24.14.0
- Presentation timezone: `America/Chicago`
- Database state before verification: all 11 migrations applied; SQLite integrity and foreign-key
  checks passed

## Bounded-window verification

A one-day, explicit UTC recovery window was requested first as a dry run. The dry run fetched 31
completed scrobbles and ignored one current-playing item; it did not create a run, evidence, or a
cursor update.

The same window was then synchronized live twice. The first live run inserted 31 previously unseen
Last.fm evidence occurrences and ignored one current-playing item. The immediate repeat fetched the
same 31 completed scrobbles, treated all 31 as existing evidence, inserted none, and again ignored
the current-playing item. Explicit recovery bounds preserved the normal cursor as designed.

## Incremental cursor verification

A subsequent normal sync started from the latest stored evidence with the configured five-minute
safety overlap. It fetched 39 completed scrobbles, reused 2 overlap occurrences, inserted 37 new
occurrences, and ignored one current-playing item. The successful run advanced the single cursor to
its latest completed-scrobble boundary.

An immediate normal repeat started from that cursor minus the same safety overlap. It fetched one
existing completed scrobble, inserted none, ignored one current-playing item, and retained the same
cursor boundary. The cursor remained linked to a wholly successful API ingest run.

Across the four live runs, the API metadata recorded four pages, 102 completed scrobbles, and four
ignored current-playing items. They inserted 68 new evidence occurrences and produced no rejected
records. No automatic cross-source match was created by these new records; they remain available to
the existing reconciliation workflow.

## Failure, validation, and privacy checks

The initial sandboxed API attempt produced the client's safe `transport` category and was retried
only after network permission was granted. It created no API ingest run or cursor state. This
confirmed the documented recoverable-failure behavior without using invalid credentials or storing a
response.

After the live runs, evidence validation passed with SQLite integrity and foreign-key checks. The
coverage report contained 123,365 source-evidence occurrences, including 62,334 Last.fm occurrences;
the increase of 68 from the historical baseline is the expected result of this synchronization. Its
only finding was the corresponding non-fatal archive-baseline deviation.

The local credential file, generated database, SQLite sidecars, and private inputs remain ignored by
Git. The sync commands emitted only safe aggregate metadata; no secret or raw API response was added
to the repository.
