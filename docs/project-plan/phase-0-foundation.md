# Phase 0: Project Foundation

## Objective

Establish a minimal Node.js 24, TypeScript, pnpm, and SQLite project whose configuration, migrations, tests, and privacy boundaries are deterministic. Do not implement real archive ingestion in this phase.

## Inputs and constraints

- Follow the repository shape and technology direction in `PROJECT_APPROACH.md`.
- Remain a single Node.js package using ECMAScript modules and strict TypeScript.
- Prefer Node's built-in test runner and a small dependency set.
- Generated databases, private inputs, outputs, local secrets, and temporary files must not be committed.

## Ordered tasks

### P0-01 — Establish repository safety boundaries

**Depends on:** none

**Work:**

- Add ignore rules for `data/inputs`, `data/database`, generated `data/outputs`, environment-secret files, SQLite sidecars, build output, coverage output, and local editor/OS files.
- Preserve required empty data directories with safe placeholders if useful.
- Add an environment example containing variable names only, including the default timezone and future Last.fm configuration.
- Add a short data-handling note explaining that private exports are immutable, local, and never fixtures.

**Acceptance:** Git does not show private inputs or generated database files as trackable; the example configuration contains no credentials; the data-handling note names all version 1 excluded fields.

### P0-02 — Scaffold the pinned TypeScript/pnpm toolchain

**Depends on:** P0-01

**Work:**

- Initialize the package manifest and pnpm lockfile.
- Pin the Node 24 major line at repository level and declare a compatible engines constraint.
- Configure strict TypeScript for ESM and source maps.
- Add deterministic scripts for build, typecheck, test, format check, lint, and the aggregate quality gate.
- Select only the focused formatter/linter/development dependencies needed now and document any non-obvious choice.

**Acceptance:** a clean install succeeds under Node 24; a trivial source module builds and tests; all quality scripts return meaningful exit codes.

### P0-03 — Implement typed configuration and safe CLI conventions

**Depends on:** P0-02

**Work:**

- Add central configuration for repository-relative data paths, database path, presentation timezone, and optional Last.fm variables.
- Validate external configuration at runtime and report missing or invalid values without printing secrets.
- Resolve defaults independently of the caller's working directory.
- Establish a small command-result contract supporting human-readable and JSON output plus documented exit-code categories.

**Acceptance:** tests cover defaults, overrides, invalid timezone/configuration, redaction, path resolution, JSON summaries, and exit codes.

### P0-04 — Add the SQLite adapter and connection policy

**Depends on:** P0-02, P0-03

**Work:**

- Introduce `better-sqlite3` behind a project-owned connection interface.
- Enable foreign keys on every connection and define the WAL policy.
- Provide transaction, prepared-statement, close, integrity-check, and temporary-database helpers.
- Keep adapter-specific types out of the domain layer.

**Acceptance:** integration tests prove foreign-key enforcement, rollback behavior, connection cleanup, and successful integrity checks.

### P0-05 — Build the migration runner

**Depends on:** P0-04

**Work:**

- Define the ordered SQL migration naming convention and migration metadata table.
- Apply pending migrations transactionally and reject changed checksums or invalid ordering.
- Add `db:migrate` and a status/validation command with human and JSON summaries.
- Make applying migrations repeatedly a no-op.

**Acceptance:** tests cover empty database creation, multiple migrations, repeat application, failed rollback, checksum drift, and status output.

### P0-06 — Create the initial schema

**Depends on:** P0-05

**Work:**

- Decide and document the canonical timestamp representation.
- Add operational, source-evidence, identity, reconciliation, canonical-event, genre-enrichment, cursor, and rejection tables described by the approach.
- Add foreign keys, uniqueness constraints, indexes, rule/version columns, and safe enumerated checks needed by known workflows.
- Explicitly omit IP address, username, user-agent, country, platform, API key, and raw rejected payload columns.
- Avoid speculative analytical materialization that can wait for later phases.

**Acceptance:** a schema contract test inspects tables, columns, indexes, constraints, and excluded-field absence; all migrations and SQLite integrity checks pass.

### P0-07 — Add synthetic fixture and test infrastructure

**Depends on:** P0-03, P0-06

**Work:**

- Add small synthetic Spotify and Last.fm fixture builders or files covering valid tracks, non-music records, missing optional data, malformed input, exact duplicates, ambiguous overlap, Unicode, and time boundaries.
- Add temporary workspace/database helpers and tests proving fixtures contain no private archive data.
- Establish unit and integration test directory conventions.

**Acceptance:** fixtures are deterministic, clearly synthetic, small enough for CI, and usable without `data/inputs`.

### P0-08 — Add foundation CI and developer workflow documentation

**Depends on:** P0-01 through P0-07

**Work:**

- Add CI that installs with the locked dependencies on Node 24 and runs the aggregate quality gate using synthetic fixtures only.
- Document setup, migration, test, validation, database rebuild, and privacy-safe troubleshooting commands.
- Confirm CI and local scripts use the same entry points.

**Acceptance:** a fresh checkout can install, migrate an empty temporary database, test, and validate by following the documentation; CI does not require secrets or private inputs.

## Phase gate

Phase 0 is complete when an empty database can be created, migrated, inspected, integrity-checked, and tested deterministically from a fresh checkout, and the repository demonstrably excludes private/generated data.

## Deliverables

- Pinned package/toolchain configuration and lockfile
- Safe configuration and CLI result contracts
- SQLite adapter and transactional migration runner
- Initial explicit schema and schema contract tests
- Synthetic fixtures and deterministic CI
- Setup, data-handling, and rebuild documentation

