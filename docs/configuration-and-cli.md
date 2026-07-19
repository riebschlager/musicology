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
| `LASTFM_USERNAME` | unset | Optional Last.fm account for future synchronization |
| `LASTFM_API_KEY` | unset | Optional Last.fm API secret for future synchronization |

Relative path overrides are resolved from the repository root. Absolute overrides remain absolute.
Changing `MUSICOLOGY_DATA_DIR` also moves the three default child paths; an explicit child override
takes precedence. The loader validates timezones, paths, and configured Last.fm values before a
command performs work. Error messages identify the variable but never repeat its supplied value.

Last.fm values are optional at the project level because most commands do not use the API. A future
Last.fm synchronization command must separately require both values at its own boundary. Commands
must pass configured Last.fm values to the result renderer as redaction values before producing
console output.

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
pnpm import:spotify data/inputs/spotify/Streaming_History_Audio_2026_0.json
pnpm import:spotify --json data/inputs/spotify/Streaming_History_Audio_2026_0.json
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
pnpm import:lastfm-export data/inputs/lastfm/history.json
pnpm import:lastfm-export --json data/inputs/lastfm/history.json
```

The command accepts regular `.json` files only when they are direct children of
`MUSICOLOGY_INPUTS_DIR/lastfm`; it never scans the directory. Relative arguments are resolved from
the current working directory. At least one path is required.

Human and JSON results include reconciled file, accepted, duplicated, and rejected counts plus the
source and overlap fingerprint contract versions. Equivalent source fingerprints retain separate
file/ordinal occurrence provenance while sharing one unique approved evidence payload. Unchanged or
byte-identical renamed content is a no-op. Failures use fixed safe diagnostics and never emit paths,
raw records, unknown fields, or source values.
