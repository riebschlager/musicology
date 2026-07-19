# Phase 1 private archive import

This document records the aggregate, privacy-safe result of project-plan task P1-08. It contains no
source rows, display values, private filenames, input hashes, account identifiers, or generated
database content.

## Run context

- Completed: 2026-07-19
- Baseline: `approach-2026-07-17` from `PROJECT_APPROACH.md`
- Runtime: Node.js 24.18.0 and pnpm 9.0.0
- Presentation timezone: `America/Chicago`
- Supported inputs: four Spotify audio files and one Last.fm export
- Other immutable input: one out-of-scope Spotify video file

The generated database was removed, rebuilt from all four migrations, and checked before import.
Migration status reported four applied migrations, no pending migrations, successful SQLite
integrity, and no foreign-key violations.

## Import and repeat-import results

| Source | Discovered records | Accepted music evidence | Duplicated accepted evidence | Excluded non-music | Rejected |
| --- | ---: | ---: | ---: | ---: | ---: |
| Spotify audio | 61,114 | 61,031 | 391 | 83 | 0 |
| Last.fm export | 62,266 | 62,266 | 0 | 0 | 0 |
| Total | 123,380 | 123,297 | 391 | 83 | 0 |

Every supported historical music row was accepted. The 83 Spotify rows not accepted as music were
valid podcast or audiobook records and were counted as the version 1 non-music exclusion; no row
was left unclassified and no malformed record required a rejection.

The exact same five supported files were then supplied to the importers again. Spotify reported all
four files as file no-ops, Last.fm reported its file as a no-op, and both commands reported zero new
records in every outcome category. The database retained 123,297 evidence occurrences.

SHA-256 snapshots covered all six private input files present at the start of the run, including the
out-of-scope video file. The complete path-and-digest snapshot was byte-for-byte identical after
migration, both import passes, validation, and coverage reporting. The private snapshots were kept
outside the repository and their values are not recorded here.

## Coverage and baseline comparison

The `coverage-v1` report reconciled to 61,031 Spotify evidence occurrences and 62,266 Last.fm
evidence occurrences. The observed UTC date ranges reproduce the approach baseline dates:

- Spotify: 2011-08-23 through 2026-02-14
- Last.fm: 2005-02-13 through 2026-04-26

Last.fm contains 10,387 rows without album text (16.68%) and 21,620 without a release MusicBrainz
identifier (34.72%), consistent with the approximate one-sixth and one-third baseline observations.
Its single 3,236-day evidence gap runs from September 2016 to July 2025 and explains the documented
absence of observations in 2017 through 2024. Spotify retains the documented sparse early years and
continuous later coverage.

The opt-in baseline comparison reported one non-fatal deviation: 391 duplicate Spotify music
evidence occurrences rather than the approach inventory's 401 duplicate audio rows. Aggregate
inspection of exact immutable input rows explains the difference completely. All Spotify audio rows
contain 401 extras across 388 exact duplicate groups; the 83 excluded podcast/audiobook rows contain
10 of those extras across 8 groups. Accepted track evidence therefore contains 391 extras across 380
groups, which is the correct evidence-layer coverage value. No baseline source count, range, gap, or
Last.fm duplicate observation remains unexplained.

## Validation and privacy audit

Archive-level validation passed for five registered source files, four successful ingest runs,
123,297 source records, zero rejected records, and 123,297 recomputed fingerprints. SQLite integrity
passed and the foreign-key violation count was zero.

The private Last.fm export uses a wrapper containing an account username and an arbitrary filename
that also contains that value. The import boundary now projects only the wrapper's `scrobbles`
array. SQLite stores a versioned opaque path locator for the Last.fm file, while validation resolves
the real direct-child input locally and still detects changed bytes at that path. The final audit
confirmed all of the following:

- no excluded field name exists in the SQLite schema;
- the private Last.fm account value does not occur in the generated database;
- summaries and validation output contain aggregate counts and safe codes only;
- no log or generated report file was created;
- private inputs, the generated database, and SQLite sidecars remain ignored by Git; and
- repository changes contain only implementation, deterministic synthetic tests, and focused
  documentation.

P1-08's archive gate is satisfied. Phase 1 is ready for review; identity and canonical-event work
remain deferred to Phase 2.
