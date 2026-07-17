# Database migrations

Committed SQL migrations live in `migrations/` and use a gap-free, four-digit sequence followed by
a lowercase snake-case description: `0001_create_initial_schema.sql`. Versions begin at `0001`.
Renaming, removing, inserting before, or editing an applied migration is invalid; add a new
migration instead.

The runner hashes each file's exact bytes with SHA-256 and records its version, description,
checksum, and UTC application time in the `schema_migration` table. Before applying anything it
validates that the recorded history is a contiguous prefix of the files on disk. All pending
migrations and their metadata rows are then applied in one `IMMEDIATE` transaction, so any failure
rolls back the entire pending batch. Repeated application with unchanged files is a no-op.

Run `pnpm db:migrate` to apply pending migrations. Run `pnpm db:status` to validate migration files
and recorded history without applying pending files. Both commands accept `--json`; JSON output is
the automation contract. The commands use `MUSICOLOGY_DATABASE_PATH` when set and otherwise use the
configured repository-relative database path.

The first domain migration, `0001_create_initial_schema.sql`, belongs to P0-06. Its table contract,
timestamp representation, provenance structure, and privacy boundary are documented in
[`database-schema.md`](database-schema.md).
