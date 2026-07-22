# Last.fm incremental synchronization

`sync:lastfm` retrieves completed `user.getRecentTracks` scrobbles and writes only the approved
evidence projection. It requires `LASTFM_USERNAME` and `LASTFM_API_KEY`; never put either value on
the command line. Configure them in the ignored local `.env` file or another local secret mechanism.

After migrating the database, run a normal sync:

```sh
pnpm sync:lastfm
pnpm sync:lastfm --json
```

The first normal sync starts five minutes before the newest imported Last.fm evidence. If there is no
Last.fm evidence, provide an explicit initial UTC epoch-millisecond boundary:

```sh
pnpm sync:lastfm --initial-from 1735689600000
```

Normal syncs use the last successful cursor minus the same five-minute safety overlap. Overlapping
scrobbles are linked to existing evidence, so a successful repeat reports them as `existing` and
does not create another analytical event. The JSON and human summaries report aggregate `fetched`,
`ignored`, `existing`, `inserted`, and `matched` counts, plus page count, safe window metadata, and
cursor status. `fetched = existing + inserted`; `ignored` is currently-playing data excluded before
persistence.

Use `--dry-run` to send and validate the same bounded API requests without creating an ingest run,
writing evidence, running reconciliation, or advancing the cursor:

```sh
pnpm sync:lastfm --dry-run --json
```

For a bounded recovery window, use explicit inclusive UTC epoch-millisecond boundaries:

```sh
pnpm sync:lastfm --from 1735689600000 --to 1735776000000
```

Any explicit `--from` or `--to` is a recovery operation and deliberately preserves the normal cursor.
`--safety-overlap-ms` changes the non-negative overlap only for that invocation. Invalid ranges fail
before a request is sent.

The command fetches and validates all pages before opening the evidence transaction. It then runs
API evidence persistence, identity resolution, canonical-event processing, and reconciliation in
the shared transaction, advancing the normal cursor only after that lifecycle succeeds. Thus
transport, validation, insert, or reconciliation failure leaves no partial API evidence and does not
advance the cursor. Client errors and command output are safe fixed categories: credentials, account
names, request URLs, response bodies, and raw records are never printed or stored.
