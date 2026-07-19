# Data handling

Files under `data/inputs` are private source evidence. Keep them local, treat them as immutable, and never rewrite them during import or synchronization. They are ignored by Git and must not be used as test fixtures. Tests must use small synthetic or anonymized fixtures stored outside `data/inputs`.

Generated databases belong under `data/database`, and generated reports or exchange files belong under `data/outputs`. Both locations are ignored except for the placeholders that preserve their directories. The database and outputs are derived state and must be reproducible without committing them.

Version 1 excludes the following data from SQLite, logs, errors, rejection diagnostics, fixtures, reports, and generated artifacts:

- IP addresses;
- account usernames copied from private exports;
- user-agent strings from source records;
- secrets, including Last.fm API keys;
- Spotify country fields;
- Spotify platform or device-context fields; and
- raw rejected payloads that could contain any excluded field.

Environment-specific configuration belongs in an ignored `.env` file. Copy `.env.example` locally when configuration is needed; the committed example contains variable names, the non-secret default timezone, and no credentials.
