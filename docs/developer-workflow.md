# Developer workflow

All commands in this document run from the repository root. They use committed synthetic fixtures
only unless a command explicitly names `data/inputs`. Foundation development and CI never require
private exports, `LASTFM_USERNAME`, or `LASTFM_API_KEY`.

## Fresh checkout

Install Node.js 24 using the version manager of your choice; `.node-version` pins the required major
line. Then enable Corepack, activate the exact pnpm version declared by `packageManager`, and install
the committed lockfile without updating it:

```sh
corepack enable
corepack install
pnpm install --frozen-lockfile
```

The install fails if the lockfile and `package.json` disagree. Do not replace it with an unlocked
install in CI or routine verification.

## Create and inspect a database

The default generated database is `data/database/musicology.sqlite3`. Apply every pending migration
and then validate the migration files, recorded checksums, SQLite integrity, and foreign keys:

```sh
pnpm db:migrate
pnpm db:status
```

Both commands accept `--json` for automation:

```sh
pnpm db:migrate --json
pnpm db:status --json
```

To prove the process on an empty database without touching local derived data, point the command at
a temporary path. The command creates the parent directory when necessary:

```sh
MUSICOLOGY_DATABASE_PATH=/tmp/musicology-foundation-check.sqlite3 pnpm db:migrate --json
MUSICOLOGY_DATABASE_PATH=/tmp/musicology-foundation-check.sqlite3 pnpm db:status --json
```

`db:migrate` is idempotent: running it again with unchanged migration files reports that the database
is up to date. Both commands fail with a data-error exit code if SQLite integrity or foreign-key
validation fails. `db:status` also validates migration naming, ordering, continuity, and checksums
without applying pending migrations.

## Import Spotify historical evidence

Apply all migrations first, then pass each supported Spotify audio export explicitly. The importer
does not scan `data/inputs` or accept a directory in place of file paths:

```sh
pnpm db:migrate
pnpm import:spotify data/inputs/spotify/Streaming_History_Audio_2011-2013_0.json
pnpm import:spotify --json data/inputs/spotify/Streaming_History_Audio_2011-2013_0.json
```

Files remain read-only. Repeating the same content, including under another supported filename,
adds no source evidence. A failed multi-file command rolls back every source write from that command.
The summary is safe to retain, but source files and generated databases remain private and ignored.

## Test and validate changes

Run the complete local and CI quality gate:

```sh
pnpm quality
```

This is the authoritative aggregate command. It runs formatting and lint checks, strict TypeScript
checking, all unit and integration tests, and a production build. The database integration tests
apply migrations to temporary empty databases and run SQLite integrity and foreign-key checks.

Individual entry points are available while iterating:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Before handing off a database-related change, run `pnpm quality`, migrate a fresh temporary database,
and run `db:status` against that same database. This mirrors `.github/workflows/ci.yml`.

## Rebuild the generated database

The SQLite database is derived state. Confirm no Musicology process has it open, then remove only the
known generated database and its SQLite sidecars before recreating it:

```sh
rm -f -- data/database/musicology.sqlite3 data/database/musicology.sqlite3-shm data/database/musicology.sqlite3-wal
pnpm db:migrate
pnpm db:status
```

Never aim a recursive removal at `data`, `data/inputs`, the repository root, or a path assembled from
an unchecked environment variable. Rebuilding the database does not authorize changing or deleting
private source exports. Historical import commands require the rebuilt database to be migrated before
use. Reconciliation commands remain later-phase work.

## Privacy-safe troubleshooting

- Check tool versions with `node --version` and `pnpm --version`. Node must be version 24 and pnpm
  must match the `packageManager` field in `package.json`.
- If `better-sqlite3` fails to load after changing Node versions, return to Node 24 and rerun
  `pnpm install --frozen-lockfile`. Do not upload the database or private input files with a bug report.
- If SQLite reports that the database is locked, stop other Musicology processes and retry. Do not
  delete `-wal` or `-shm` files while a process has the database open.
- If `db:status` reports checksum drift, restore the committed migration. Applied migrations are
  immutable; schema changes belong in a new migration.
- Configuration errors name the invalid variable without echoing its value. Share the safe error code
  and message, not environment values, `.env` contents, raw source records, or database files.
- Tests must use `tests/fixtures`; private archive rows must never be copied into fixtures, snapshots,
  logs, issues, or CI artifacts.

## CI boundary

CI runs on Node 24 with the locked pnpm dependencies and read-only repository permissions. It sets
`MUSICOLOGY_DATA_DIR` to the runner's temporary directory, runs `pnpm quality`, migrates an empty
temporary database, and validates it with `pnpm db:status`. The workflow does not read `data/inputs`,
declare secrets, call Last.fm, or upload databases or reports.
