# Public snapshot pipeline

P6-04 implements the local private-to-public boundary as project-owned TypeScript modules under
`src/publication`. It does not add a command-line release workflow; P6-10 owns the stable generation,
review, approval, and site-build commands.

## Inputs and projection boundary

`loadPrivateAnalyticalBundle` reads the complete ignored analytical export bundle and compares its
manifest database state with a separately verified expected state. It accepts only the fixed export
manifest and the `volume`, `artist-eras`, `rediscovery`, `abandonment`, `genre-eras`, and `coverage`
artifacts. Every analytical envelope, parameter object, result record, coverage record, nested key,
rate, count, and shared context is runtime-validated before the adapter returns it. Missing files,
state drift, unsupported or unknown fields, forbidden nested fields, digest mismatches, and
inconsistent counts or shared coverage fail with sanitized error codes; source records and payload
values are never included in diagnostics.

`projectPublicSnapshot` creates new closed objects field by field. It reduces exact event timestamps
to the public month/date contract, validates the Phase 4 month-based era bounds without reinterpreting
them as instants, enforces the P6-02 artist thresholds and result limits, resolves reviewed artist
and story selections, and runs every artifact through the executable public-schema validator. If an
artist-era interval exceeds its evidence bound, projection retains a deterministic contiguous
segment centered as closely as possible on the analytical peak and recomputes that segment's
play-count/share aggregate. The selected-track artist name, track name, story slug, and public track
slug are wholly manual reviewed editorial identity. They do not resolve to a private analytical
track candidate and do not create track-level analytical evidence. Rediscovery evidence must be
artist-scoped, and any non-null public artist slug on a rediscovery or dormancy story must resolve to
the same private analytical artist through the reviewed selection map.

Story evidence is reconciled before reduction: rediscovery gap days must equal the difference
between the selected private prior-listen and return instants, and dormancy observation days must
equal the interval from the selected private last listen through the analytical as-of boundary.
After reduction, the public contract rechecks that each day count remains possible within its
published month/date bounds. A supersession link is accepted only from a later rediscovery to a
dormancy conclusion for the same private artist; the closed public artifact also rechecks link
direction, public chronology, target presence, and matching public artist slugs when both are shown.

P6-04 emits `history.json`, `artists.json`, `editorial.json`, and `stories.json`. P6-09 deferred the
experimental genre lab from the initial release, so `genre-lab.json` remains absent and the public
manifest keeps `artifacts.genreLab` null. The committed full and empty synthetic snapshots under
`tests/fixtures/public-snapshots` contain no private archive data and are suitable for downstream
site development and deterministic tests.

## Candidate and approval states

`buildPublicCandidate` uses stable key ordering, fixed filenames, newline-terminated JSON, SHA-256
artifact hashes, and a deterministic snapshot hash. Its `review-report.json` records every artifact
allowlist, hash, record count, public slug, common date/coverage/version context, prior snapshot,
additions, removals, changed artifacts, and selection-policy changes.

The report binds the candidate-manifest preimage with `reportSha256` set to 64 zeroes. The final
candidate manifest then binds the exact report hash. This explicit convention avoids a circular
self-hash. An approved manifest is normalized back to candidate state when that binding is checked,
so approval can retain the exact reviewed artifact and report bytes.

`writePublicCandidate` writes and validates a complete staging directory before atomically replacing
an earlier candidate. If replacement succeeds but removal of the retained backup fails, the new
candidate remains the reported committed result and the recoverable backup may remain as cleanup
residue; a failed replacement rename restores the prior destination before reporting failure.
`approvePublicCandidate` separately validates the reviewed candidate, copies
the exact artifact and report bytes into a new immutable approved directory, and adds only the
approved manifest state and `approval.json`. Artifact `publicationDate` values therefore remain
`null`; the approved manifest and approval record are the authoritative publication date and state.
Re-approving an existing snapshot ID fails closed.

The intended ignored candidate location is `data/outputs/publication-candidates/<snapshot-id>/`.
Approved snapshots are retained at `data/publication/approved/<snapshot-id>/`. Activation writes a
small `data/publication/active.json` pointer only after validating the target approved snapshot.
Rollback repoints that file to any retained approved snapshot and never reads SQLite, private
inputs, or the private analytical bundle.

The pipeline is a filesystem boundary, not a database migration. It makes no schema changes and
requires no database access after projection.

The committed fixture JSON preserves the generator's exact bytes so its manifest and report hashes
remain meaningful. Biome therefore excludes `tests/fixtures/public-snapshots`; the integration test
regenerates both snapshots and compares every parsed contract and byte sequence instead.
