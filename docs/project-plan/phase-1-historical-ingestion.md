# Phase 1: Historical Ingestion

## Objective

Import supported historical Spotify track plays and Last.fm scrobbles as immutable, source-shaped evidence with safe rejection handling, deterministic fingerprints, idempotency, and a first coverage report. Canonical cross-source reconciliation remains Phase 2 work.

## Entry criteria

- Phase 0 gate passes.
- The schema can represent ingest runs, source files, source records, rejections, and non-music counts.
- Synthetic fixtures cover all required import outcomes.

## Ordered tasks

### P1-01 — Define shared importer contracts and ingest lifecycle

**Depends on:** Phase 0

**Work:**

- Define supported-source discovery, content hashing, ingest-run, file registration, record outcome, and summary contracts.
- Specify safe error codes for unsupported files, malformed files, rejected records, duplicates, and excluded non-music records.
- Implement the transactional ingest lifecycle so failed imports cannot leave completed runs or partial evidence.
- Define deterministic source fingerprint requirements separately from file hashes.

**Acceptance:** tests cover successful, no-op, partially rejected, and failed runs; summaries reconcile discovered, accepted, duplicated, excluded, and rejected counts.

### P1-02 — Implement Spotify boundary validation and classification

**Depends on:** P1-01

**Work:**

- Discover only explicitly supported Spotify audio export files.
- Parse and runtime-validate the file and each record without copying unapproved fields into intermediate persistence or diagnostics.
- Classify track, episode/audiobook, video/unsupported, and malformed records.
- Convert Spotify stop time and derive start time from `ms_played` using tested UTC arithmetic.
- Project an allowlisted source-record type that preserves approved display text and evidence fields.

**Acceptance:** fixture tests cover valid tracks, missing track URI, non-music classifications, zero/short duration, Unicode, malformed records, timestamp errors, and sensitive-field redaction.

### P1-03 — Persist Spotify evidence idempotently

**Depends on:** P1-02

**Work:**

- Hash and register source files by content, preserving relative path and ordinal record location.
- Compute a stable full-record fingerprint for accepted track records.
- Insert every accepted row, including separate occurrences of exact duplicate export rows, while recording their shared fingerprint/group.
- Record only safe rejection diagnostics and non-music counts.
- Add `import:spotify` with explicit paths plus human and JSON summaries.

**Acceptance:** an unchanged file rerun inserts no evidence; a byte-identical renamed file is recognized by hash; 401-style exact duplicates can remain separate evidence rows; a failed file rolls back; no excluded field exists in the database or output.

### P1-04 — Implement Last.fm export boundary validation

**Depends on:** P1-01

**Work:**

- Discover and parse the supported Last.fm export format.
- Runtime-validate required fields while tolerating missing optional album and identifier values.
- Normalize millisecond timestamps to canonical UTC representation.
- Preserve original artist, album, and track display text exactly in approved fields.
- Define a source fingerprint suitable for later export/API overlap deduplication.

**Acceptance:** fixture tests cover missing album data, absent MusicBrainz IDs, Unicode, malformed timestamps, empty required text, and deterministic fingerprints.

### P1-05 — Persist Last.fm export evidence idempotently

**Depends on:** P1-04

**Work:**

- Register the export file and insert accepted scrobbles, safe rejections, and ingest summaries transactionally.
- Preserve source origin and ordinal location.
- Enforce fingerprint uniqueness semantics without silently discarding source provenance.
- Add `import:lastfm-export` with human and JSON summaries.

**Acceptance:** unchanged reruns are no-ops; equivalent fingerprints are handled according to the documented evidence policy; failures roll back; summaries reconcile to persisted rows.

### P1-06 — Add evidence-layer validation and archive invariants

**Depends on:** P1-03, P1-05

**Work:**

- Extend `validate` to check source-file hashes, ingest-run totals, record ordinals, fingerprint constraints, rejection summaries, foreign keys, and database integrity.
- Detect changed files at previously registered paths without modifying evidence.
- Report baseline deviations as findings rather than hard-coding the current archive counts as permanent truth.

**Acceptance:** seeded inconsistency tests fail with safe, actionable messages; valid synthetic imports pass; validation never dumps raw source records.

### P1-07 — Produce the first coverage report

**Depends on:** P1-06

**Work:**

- Add `report:coverage` for source-evidence counts by source/year, observed ranges, accepted/rejected/non-music totals, duplicate groups, missing-field rates, and long gaps.
- Include report version, generation time, timezone, input hashes, and clear distinction between evidence counts and future canonical-event counts.
- Support deterministic JSON output and concise human output.
- Add local archive-baseline comparison that is not required by CI.

**Acceptance:** report totals reconcile to tables; synthetic gap and missing-data cases are tested; repeat reports over unchanged data are stable except for declared generation metadata.

### P1-08 — Run and document the private archive import

**Depends on:** P1-01 through P1-07

**Work:**

- Rebuild a local database and import all supported files from `data/inputs` without changing them.
- Run a second import and prove it is a no-op.
- Compare the coverage report to the approach baseline, investigate meaningful differences, and document only aggregate, non-sensitive findings.
- Confirm all excluded fields are absent from schema, logs, summaries, outputs, and repository changes.

**Acceptance:** every supported historical music record is accepted or safely rejected with an explanation; the second run adds nothing; hashes confirm inputs are unchanged; archive-level validation passes.

## Phase gate

Phase 1 is complete when all supported historical track records exist as source evidence or explicit safe rejections, unchanged imports are no-ops, coverage findings reproduce or explain the baseline, and no excluded data has entered derived state.

