# Musicology

Musicology is a local-first system for building an explainable analytical dataset from personal
Spotify and Last.fm listening history. The project has established its deterministic
TypeScript/SQLite foundation and can persist supported historical Spotify audio and Last.fm JSON
exports as source evidence. Cross-source reconciliation remains a later task.

## Developer quick start

Use Node.js 24 and the pnpm version pinned in `package.json`:

```sh
corepack enable
corepack install
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm quality
pnpm db:status
pnpm validate
```

These are the same project entry points used by CI. No Last.fm credentials or private files under
`data/inputs` are needed for setup, migrations, tests, or validation.

To import a private Spotify archive after setup, explicitly name each supported audio export:

```sh
pnpm --silent import:spotify data/inputs/spotify/Streaming_History_Audio_2026_0.json
```

To import a private Last.fm history export, explicitly name each supported JSON file directly inside
the dedicated Last.fm input directory:

```sh
pnpm --silent import:lastfm-export data/inputs/lastfm/history.json
```

After imports, `pnpm validate` verifies source hashes, evidence invariants, ingest totals,
fingerprints, rejection diagnostics, foreign keys, and SQLite integrity without changing inputs or
derived state.

See [Developer workflow](docs/developer-workflow.md) for fresh-checkout verification, safe database
rebuilds, command details, and troubleshooting. See [Data handling](docs/data-handling.md) before
working with personal exports.

## Project documentation

- [Project approach](PROJECT_APPROACH.md)
- [Phased project plan](PROJECT_PLAN.md)
- [Configuration and CLI conventions](docs/configuration-and-cli.md)
- [Database schema](docs/database-schema.md)
- [Phase 1 private archive import](docs/phase-1-private-archive-import.md)
- [Migration policy](docs/migrations.md)
- [Toolchain](docs/toolchain.md)
