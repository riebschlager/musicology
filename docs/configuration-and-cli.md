# Configuration and CLI conventions

All commands load configuration through `src/config/config.ts`. Defaults are resolved from the
repository root, not from the process working directory, so invoking a built command elsewhere does
not redirect private inputs or generated output accidentally.

## Environment configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MUSICOLOGY_TIMEZONE` | `America/Chicago` | IANA timezone used to present calendar-based results |
| `MUSICOLOGY_DATA_DIR` | `data` | Base data directory |
| `MUSICOLOGY_INPUTS_DIR` | `<data>/inputs` | Immutable private source files |
| `MUSICOLOGY_DATABASE_PATH` | `<data>/database/musicology.sqlite3` | Generated SQLite database |
| `MUSICOLOGY_OUTPUTS_DIR` | `<data>/outputs` | Generated reports and exchange files |
| `LASTFM_USERNAME` | unset | Optional Last.fm account for `sync:lastfm` synchronization |
| `LASTFM_API_KEY` | unset | Optional Last.fm API secret for `sync:lastfm` synchronization |

Relative path overrides are resolved from the repository root. Absolute overrides remain absolute.
Changing `MUSICOLOGY_DATA_DIR` also moves the three default child paths; an explicit child override
takes precedence. The loader validates timezones, paths, and configured Last.fm values before a
command performs work. Error messages identify the variable but never repeat its supplied value.

Last.fm values are optional at the project level because most commands do not use the API.
`sync:lastfm` requires both values at its own boundary. Commands must pass configured Last.fm
values to the result renderer as redaction values before producing console output.

The P3-01 API client boundary is documented in
[`lastfm-api-client.md`](lastfm-api-client.md).

## Command results and exit codes

Commands return the shared result contract in `src/cli/result.ts`: command name, success/error
status, numeric exit code, concise summary, and optional structured data or safe errors. The same
result can be rendered as concise human text or one JSON object followed by a newline. JSON is the
automation contract; diagnostic logging must not be mixed into standard output in JSON mode.

Exit-code categories are stable:

| Code | Category | Meaning |
| ---: | --- | --- |
| 0 | Success | The requested operation completed successfully |
| 1 | Internal error | An unexpected implementation or dependency failure occurred |
| 2 | Usage error | Command syntax or arguments were invalid |
| 3 | Configuration error | Environment or runtime configuration was missing or invalid |
| 4 | Data error | Input, validation, migration, integrity, or domain data was invalid |

A command may refine safe string error codes inside its structured result, but it must retain the
numeric category. Secrets, usernames, excluded source fields, and raw rejected payloads must never
be included in command results.

## Spotify historical import

After applying all migrations, import one or more explicitly named Spotify extended-history audio
files:

```sh
pnpm --silent import:spotify data/inputs/spotify/Streaming_History_Audio_2026_0.json
pnpm --silent import:spotify --json data/inputs/spotify/Streaming_History_Audio_2026_0.json
```

The command accepts files only inside `MUSICOLOGY_INPUTS_DIR` whose names match the supported Spotify
audio-export convention. It never scans directories. Relative arguments are resolved from the
current working directory; absolute paths are also accepted subject to the same input-root boundary.
At least one path is required.

The database must already be migrated and current. Human and JSON results include reconciled file,
accepted, duplicated, excluded, rejected, and non-music category counts. An unchanged file or a
byte-identical renamed file is reported as a no-op and adds no evidence. Import failures use safe
codes and fixed summaries rather than paths, raw records, parser messages, or excluded field values.
The complete persistence and fingerprint contract is documented in
[`historical-ingestion-contracts.md`](historical-ingestion-contracts.md).

## Last.fm historical export import

After applying all migrations, import one or more explicitly named JSON exports directly from the
dedicated Last.fm input directory:

```sh
pnpm --silent import:lastfm-export data/inputs/lastfm/history.json
pnpm --silent import:lastfm-export --json data/inputs/lastfm/history.json
```

The command accepts regular `.json` files only when they are direct children of
`MUSICOLOGY_INPUTS_DIR/lastfm`; it never scans the directory. Relative arguments are resolved from
the current working directory. At least one path is required. The database stores a versioned,
hashed path locator rather than the arbitrary Last.fm filename because that filename may contain an
account username; validation resolves the locator locally without returning the filename.
The documented `pnpm --silent` form is also a privacy boundary: it suppresses pnpm's script preamble,
which would otherwise echo the positional source path before the redacted CLI result is rendered.

Human and JSON results include reconciled file, accepted, duplicated, and rejected counts plus the
source and overlap fingerprint contract versions. Equivalent source fingerprints retain separate
file/ordinal occurrence provenance while sharing one unique approved evidence payload. Unchanged or
byte-identical renamed content is a no-op. Failures use fixed safe diagnostics and never emit paths,
raw records, unknown fields, or source values.

## Evidence validation

Run evidence-layer validation after historical imports:

```sh
pnpm validate
pnpm validate --json
```

The command is read-only and requires a fully migrated database. It uses one deferred read
transaction so every database check observes a consistent committed snapshot. Validation opens only
an existing database in SQLite read-only mode; a missing database fails without creating the database
or its parent directories, and validation never changes journal mode. It verifies every registered
file against the bytes at its configured evidence path, reconciles ingest-run totals with persisted
evidence, validates file/record/run ownership, validates ordinal ranges and excluded-record gaps,
recomputes approved record fingerprints, checks Last.fm occurrence links, validates fixed rejection
codes and summaries, and validates status-compatible ingest-run error summaries before running
SQLite integrity and foreign-key checks. Errors identify only safe database IDs, counts, and
invariant names; they never return paths, display text, hashes, stored diagnostic text, or raw source
records.

## Manual reconciliation review

```sh
pnpm review:decisions
pnpm review:decisions --json --import path/to/manual-decisions.json
```

The export writes the fixed ignored `manual-review-decisions.json` under `MUSICOLOGY_OUTPUTS_DIR`
and refuses to overwrite it. Imports validate all `manual-decisions-v1` references, create a
SQLite-consistent backup beside the database before a non-empty bulk import, and apply every
decision transactionally. Command output reports only aggregate counts and the backup filename; it
never echoes artifact contents or paths.

The aggregate archive observations documented on 2026-07-17 are comparison baselines, not database
constraints. Differences appear as `archive_baseline_deviation` findings and do not make an
otherwise valid database fail. A changed or missing file at a registered path is an invariant error
because the stored evidence can no longer be reproduced from that path.

## Evidence coverage report

Produce the versioned evidence-layer coverage report after historical imports:

```sh
pnpm report:coverage
pnpm report:coverage --json
```

The command is read-only, requires a fully migrated existing database, and observes one deferred
read snapshot. Human output is a concise source summary. JSON output is the deterministic
`coverage-v2` automation contract: source-evidence occurrence counts by presentation-timezone year,
UTC observed ranges, accepted/rejected/non-music totals, exact-fingerprint duplicate groups and
extra occurrences, nullable approved-field rates, and same-source gaps of at least 365 exact
24-hour days. It also declares current and unresolved canonical-event counts, source backing
(Spotify, Last.fm, or both), exact and inferred merge counts, unresolved rates, overlap by year,
generation time, timezone, input content hashes, and report semantics. Repeating the report over unchanged evidence
changes only `generatedAt`.

For the local private-archive review in P1-08, compare the aggregate report with the versioned
observations in `PROJECT_APPROACH.md`:

```sh
pnpm report:coverage --compare-archive-baseline
pnpm report:coverage --json --compare-archive-baseline
```

The comparison is opt-in, reports aggregate deviations without failing the command, and is not part
of CI. Input paths and source display values are omitted; input hashes are included because they are
the explicit evidence identity required by the report contract.

## Reconciliation calibration sample

After P2-06 candidate features have been generated, export a local labeling sample:

```sh
pnpm export:reconciliation-calibration
pnpm export:reconciliation-calibration --json --per-stratum 50
```

The command requires a current, existing database and reads it without modifying it. It writes the
fixed, Git-ignored file `reconciliation-calibration-sample.json` under `MUSICOLOGY_OUTPUTS_DIR`.
The deterministic stratified sample uses a stable hash ranking within each policy stratum, avoiding
source-ingestion-order bias while producing the same sample for unchanged candidates. It includes
only local candidate/source-record IDs, feature scores,
the policy's proposed band, and a null label placeholder. It excludes source display values,
timestamps, paths, hashes, usernames, secrets, raw records, and all excluded source fields. Command
output reports only aggregate metadata and the fixed filename. The export is a local review aid and
must not be committed. To protect local labels, the command refuses to overwrite an existing sample;
move or remove that private artifact deliberately before exporting a replacement.

## Reconciliation

Run the complete Phase 2 identity-and-reconciliation pipeline and apply the current conservative
policy:

```sh
pnpm reconcile --dry-run
pnpm reconcile --json --rule-version cross-source-decision-policy-v1
```

The command resolves any unrepresented evidence, materializes canonical events, collapses exact
within-source duplicates, generates bounded candidates, calculates match features, and applies the
policy in one transaction. The dry run performs the same work inside a transaction that is rolled
back, so it does not modify the database. A non-dry run performs candidate-state updates,
decision-history writes, event supersession, and evidence-link moves atomically. Output is
aggregate-only: stage counts, policy version, and counts of automatic accepts, reviews, ignores,
and superseded automatic decisions; it never returns source display text, timestamps, paths,
hashes, or raw records.
