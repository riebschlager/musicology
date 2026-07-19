# Musicology

Musicology is a local-first system for building an explainable analytical dataset from personal
Spotify and Last.fm listening history. The project has established its deterministic
TypeScript/SQLite foundation and can persist supported historical Spotify audio exports as source
evidence. Last.fm ingestion and cross-source reconciliation remain later tasks.

## Developer quick start

Use Node.js 24 and the pnpm version pinned in `package.json`:

```sh
corepack enable
corepack install
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm quality
pnpm db:status
```

These are the same project entry points used by CI. No Last.fm credentials or private files under
`data/inputs` are needed for setup, migrations, tests, or validation.

To import a private Spotify archive after setup, explicitly name each supported audio export:

```sh
pnpm import:spotify data/inputs/spotify/Streaming_History_Audio_2026_0.json
```

See [Developer workflow](docs/developer-workflow.md) for fresh-checkout verification, safe database
rebuilds, command details, and troubleshooting. See [Data handling](docs/data-handling.md) before
working with personal exports.

## Project documentation

- [Project approach](PROJECT_APPROACH.md)
- [Phased project plan](PROJECT_PLAN.md)
- [Configuration and CLI conventions](docs/configuration-and-cli.md)
- [Database schema](docs/database-schema.md)
- [Migration policy](docs/migrations.md)
- [Toolchain](docs/toolchain.md)
