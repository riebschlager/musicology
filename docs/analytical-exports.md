# Analytical exports

P4-08 defines the versioned, local analytical bundle consumed by a future presentation layer. Run
`pnpm export:analytics` after reconciliation and analytics are current. The generated, Git-ignored
directory is `data/outputs/analytics-v1` unless `MUSICOLOGY_OUTPUTS_DIR` overrides it.

## Contract

`manifest.json` uses `analytical-export-v1`. It identifies the five fixed artifact filenames and
their SHA-256 content digests. The artifacts use `analytical-export-artifact-v1` and contain:

- `volume.json`
- `artist-eras.json`
- `rediscovery.json`
- `abandonment.json`
- `coverage.json`

Each artifact includes the relevant versioned analysis result (or aggregate coverage report), its
artifact/schema version, and one shared database-state descriptor. The descriptor has the ordered
applied migration checksums and a SHA-256 canonical-state fingerprint. That fingerprint covers the
current canonical analytical base plus aggregate coverage; it is a detector, not a source-data
export. It does not disclose source rows or source-file locations.

Files are deterministically serialized with sorted keys. A complete bundle is written to a sibling
staging directory before the published directory is replaced, so a failed write retains the prior
verified bundle. `pnpm export:analytics --check` verifies both hashes and whether the descriptor
still matches the current migrated database and deterministic analytical contract. A mismatch is a
stale or invalid export and requires regeneration.

## Privacy boundary

Exports are constructed from existing analytical result envelopes and the aggregate coverage report,
not from raw source tables. They can include canonical artist/track display values where an analysis
already needs them, but never source record IDs, raw source payloads, private filenames or paths,
account usernames, IP addresses, device/platform/country fields, user-agent strings, credentials, or
secrets. Treat the bundle as private derived personal data and do not commit it.
