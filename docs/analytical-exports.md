# Analytical exports

P4-08 defines the versioned, local analytical bundle consumed by a future presentation layer.
P5-07 adds a required genre-era artifact, so it introduces the incompatible v2 bundle. Run
`pnpm export:analytics` after reconciliation and analytics are current. The generated, Git-ignored
directory is `data/outputs/analytics-v2` unless `MUSICOLOGY_OUTPUTS_DIR` overrides it.

## Contract

`manifest.json` uses `analytical-export-v2`. It identifies the six fixed artifact filenames and
their SHA-256 content digests. The artifacts use `analytical-export-artifact-v2` and contain:

- `volume.json`
- `artist-eras.json`
- `genre-eras.json`
- `rediscovery.json`
- `abandonment.json`
- `coverage.json`

Each artifact includes the relevant versioned analysis result (or aggregate coverage report), its
artifact/schema version, and one shared database-state descriptor. The descriptor has the ordered
applied migration checksums, a SHA-256 canonical-state fingerprint, and a SHA-256 raw-mode
genre-evidence fingerprint. The first covers the current canonical analytical base plus aggregate
coverage; the second covers the normalized contribution evidence consumed by `genre-eras.json`.
They are detectors, not source-data exports, and do not disclose source rows or source-file
locations.

`genre-eras.json` uses raw-tag mode because the bundle has no implicit taxonomy selection. Its
envelope explicitly declares mode, provider, artist-level weighting, fetch-age split, and usable
event coverage; low coverage qualifies the result rather than being presented as complete history.

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
