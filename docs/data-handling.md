# Data handling

Files under `data/inputs` are private source evidence. Keep them local, treat them as immutable, and never rewrite them during import or synchronization. They are ignored by Git and must not be used as test fixtures. Tests must use small synthetic or anonymized fixtures stored outside `data/inputs`.

Generated databases belong under `data/database`, and generated reports or exchange files belong under `data/outputs`. Both locations are ignored except for the placeholders that preserve their directories. The database and outputs are derived state and must be reproducible without committing them.

Phase 6 adds one deliberately narrower exception: only public snapshot bytes that have passed the
versioned allowlist, deterministic disclosure report, and explicit approval workflow may be copied
to and committed under `data/publication/approved/<snapshot-id>/`, together with the approval record
and active-snapshot pointer. Private analytical bundles and generated candidates/reports remain
under ignored `data/outputs`; placing a file under `data/publication` does not itself approve it.
The complete boundary and withdrawal/rollback workflow are defined in
[`decisions/phase-6-publication-contract.md`](decisions/phase-6-publication-contract.md). The
implemented projection, deterministic hashing, staging, approval, and active-pointer behavior are
documented in [`public-snapshot-pipeline.md`](public-snapshot-pipeline.md).

Version 1 excludes the following data from SQLite, logs, errors, rejection diagnostics, fixtures, reports, and generated artifacts:

- IP addresses;
- account usernames copied from private exports;
- user-agent strings from source records;
- secrets, including Last.fm API keys;
- Spotify country fields;
- Spotify platform or device-context fields; and
- raw rejected payloads that could contain any excluded field.

Environment-specific configuration belongs in an ignored `.env` file. Copy `.env.example` locally when configuration is needed; the committed example contains variable names, the non-secret default timezone, and no credentials.
