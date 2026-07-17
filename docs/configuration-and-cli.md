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
