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
pnpm --silent import:spotify data/inputs/spotify/Streaming_History_Audio_2011-2013_0.json
pnpm --silent import:spotify --json data/inputs/spotify/Streaming_History_Audio_2011-2013_0.json
```

Files remain read-only. Repeating the same content, including under another supported filename,
adds no source evidence. A failed multi-file command rolls back every source write from that command.
The summary is safe to retain, but source files and generated databases remain private and ignored.

## Import Last.fm historical export evidence

Apply all migrations first, then explicitly name each supported JSON export directly inside the
dedicated Last.fm input directory. The importer does not scan the directory:

```sh
pnpm db:migrate
pnpm --silent import:lastfm-export data/inputs/lastfm/history.json
pnpm --silent import:lastfm-export --json data/inputs/lastfm/history.json
```

Files remain read-only. Repeating unchanged or byte-identical renamed content adds no occurrence or
payload evidence. Equivalent scrobble fingerprints retain separate ordinal provenance and are
reported as duplicates. A failed multi-file command rolls back all source writes from that command.
Summaries contain only aggregate counts and contract versions; exports and generated databases
remain private and ignored. Keep `--silent` before the script name: pnpm's normal script preamble
echoes positional arguments, and a Last.fm export filename can itself contain an account identifier.

## Validate historical evidence

After importing either source, validate the source bytes and evidence layer without modifying the
inputs or database:

```sh
pnpm validate
pnpm validate --json
```

Validation fails with a data-error exit code for changed or missing registered files, inconsistent
ingest totals, incompatible file/record/run ownership, inconsistent ordinals, incorrect fingerprints
or Last.fm occurrence links, unsafe rejection metadata, unsafe ingest-run error summaries,
foreign-key violations, or SQLite integrity failures. The documented archive counts are reported
only as non-fatal baseline findings, so a legitimate replacement export can be investigated without
redefining an evidence invariant. Diagnostics contain safe IDs and aggregate counts only.
Arbitrary Last.fm filenames are represented in SQLite by opaque path locators; validation resolves
them against direct JSON children of the private Last.fm input directory without reporting or
persisting a filename that may contain an account username.

## Report historical evidence coverage

Generate the first coverage report from the same migrated database:

```sh
pnpm report:coverage
pnpm report:coverage --json
```

The human form is concise; JSON is the stable automation form and includes input hashes without
including input paths or source record values. Year grouping uses `MUSICOLOGY_TIMEZONE`, which
defaults to `America/Chicago`. The report counts source evidence occurrences and explicitly does not
claim to count future reconciled canonical events.

The documented private-archive baseline comparison is a local P1-08 workflow, not a CI check:

```sh
pnpm report:coverage --compare-archive-baseline
```

## Test and validate changes

Run the complete local and CI quality gate:

```sh
pnpm quality
```

This is the authoritative aggregate command. It runs formatting and lint checks, strict TypeScript
checking for the data pipeline and typed site logic, all unit and integration tests, the TypeScript
production build, deterministic full and empty static-site fixture builds, and built-site privacy,
metadata, and byte-budget verification. The database integration tests apply migrations to
temporary empty databases and run SQLite integrity and foreign-key checks.

Individual entry points are available while iterating:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Develop and verify the public microsite shell

The normal development server and fixture builds consume only the committed deterministic public
snapshot. They do not read the private database, private analytical bundle, or `data/inputs`:

```sh
pnpm site:dev
pnpm site:typecheck
pnpm site:test
pnpm site:build:fixture
pnpm site:verify
```

Use `pnpm site:build:empty` followed by `pnpm site:verify` to verify the no-history state.
`site:verify` detects whether the current built fixture has history and checks the corresponding
chart/table or empty-state contract. Generated `site/dist` and `site/.astro` files are ignored.

The browser suite builds the full fixture and checks the route shell in desktop and mobile Chromium,
including automated accessibility, keyboard navigation, 320-pixel reflow, reduced motion,
JavaScript-disabled reading, URL-state bounds, and unexpected network requests:

```sh
pnpm exec playwright install chromium
pnpm site:test:browser
```

Playwright browser binaries are a separately installed local prerequisite and are not committed. CI
runs the browser suite after the aggregate quality gate in the exact-pinned Playwright Linux
container, including its Chromium binary and font set. Functional, accessibility, responsive, and
interaction checks run locally on supported platforms; pixel snapshot comparisons run only in that
documented Linux environment so host font metrics do not create false regressions.

After an intentional, reviewed visual change, regenerate the six Linux baselines from the repository
root with the exact Playwright image pinned by `@playwright/test`:

```sh
docker run --rm --ipc=host --platform linux/amd64 \
  --env ASTRO_TELEMETRY_DISABLED=1 \
  --env CI=1 \
  --env COREPACK_HOME=/tmp/corepack \
  --mount type=bind,source="$PWD",target=/work \
  --tmpfs "/work/node_modules:exec,uid=$(id -u),gid=$(id -g)" \
  --user "$(id -u):$(id -g)" \
  --workdir /work \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  /bin/bash -lc 'mkdir -p /tmp/corepack-bin && corepack enable --install-directory /tmp/corepack-bin && export PATH="/tmp/corepack-bin:$PATH" && pnpm install --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store && pnpm site:test:browser --update-snapshots'
```

Review every changed PNG, then rerun the same container command without `--update-snapshots`.
`pnpm site:build` is intentionally different from the fixture commands: it fails closed unless
`data/publication/active.json` identifies a complete approved snapshot. Candidate fixtures can never
satisfy that production boundary. The approval and deployment commands remain P6-10 work.

Astro's separate checker is not installed while its official peer range excludes the repository's
TypeScript 7 compiler. The temporary diagnostic gate and the reason for retaining `.astro` source
are recorded in
[`phase-6-static-web-visualization-stack.md`](decisions/phase-6-static-web-visualization-stack.md).

Before handing off a database-related change, run `pnpm quality`, migrate a fresh temporary database,
run `db:status`, and run `validate` against that same database. This mirrors the database checks used
for evidence-layer work while keeping private inputs outside CI.

## Manage a genre taxonomy

P5-05 curated genre mappings are imported from and exported to explicit portable JSON artifacts:

```sh
pnpm genre:taxonomy --import path/to/genre-taxonomy.json
pnpm genre:taxonomy --export taxonomy-v1 --output path/to/genre-taxonomy.json
```

The artifact format and its versioning, validation, and licensing boundary are documented in
[`genre-taxonomy-mapping.md`](genre-taxonomy-mapping.md). Use a new taxonomy version whenever the
hierarchy or mapping decisions change; raw provider evidence is never rewritten.

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
