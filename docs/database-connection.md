# Database connection policy

SQLite access goes through the project-owned interfaces in `src/db/connection.ts`. The
`better-sqlite3` dependency and its types are confined to the adapter implementation so migrations,
importers, analytics, and domain code do not depend on adapter-specific contracts.

Every connection enables SQLite foreign-key enforcement and uses a five-second busy timeout.
Writable file-backed databases use write-ahead logging (WAL), which persists on the database file
and supports the expected local pattern of sequential writes with concurrent reads. In-memory
databases retain SQLite's `memory` journal mode because WAL is not available for `:memory:`.

Transactions default to `IMMEDIATE` mode so a write workflow discovers contention before doing
work; callers may explicitly request `DEFERRED` or `EXCLUSIVE`. Exceptions escape unchanged and
cause SQLite to roll back the transaction. Integrity checks combine `PRAGMA integrity_check` with
`PRAGMA foreign_key_check`, since SQLite's general integrity check does not report foreign-key
violations.

The temporary-database helpers create file-backed databases so tests exercise the production WAL
policy. Their cleanup operation is idempotent, closes the connection first, and removes the database
and sidecar files.
