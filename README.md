# Musicology

Musicology is a local-first system for building an explainable analytical dataset from personal
Spotify and Last.fm listening history. The project is currently establishing its deterministic
TypeScript and SQLite foundation; real archive ingestion is intentionally not part of Phase 0.

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
