# Musicology Phased Project Plan

Status: Ready for execution  
Source: [`PROJECT_APPROACH.md`](PROJECT_APPROACH.md)  
Plan date: 2026-07-17

## Mission

Build a local-first, reproducible music-history laboratory that turns the unchanged Spotify and Last.fm archive into a trustworthy, explainable analytical dataset, then adds synchronization, analysis, enrichment, and visualization without losing provenance or hiding uncertainty.

This plan translates the project approach into ordered tasks sized for one focused Codex implementation session. The approach document remains authoritative for product intent and design principles; these documents are the execution map.

## How to execute this plan

1. Complete phases in order. A later phase may begin only when the preceding phase gate passes, unless the task explicitly says it can run independently.
2. Within a phase, complete tasks in task-ID order unless their dependency lists allow otherwise.
3. Treat each task as a proposed review and commit boundary. Do not mix unrelated cleanup or future-phase work into it.
4. Before editing, inspect the current repository and preserve user changes. Reconfirm that the task's assumptions still match the code.
5. Add or update tests in the same task as the behavior they verify.
6. Run the task-level verification commands plus the repository-wide quality checks that exist at that point.
7. Record material schema, rule, metric, or output-contract decisions in the repository. Do not leave important behavior only in chat history.
8. Do not use private archive records as committed fixtures. Synthetic or anonymized fixtures must be sufficient for CI.

## Definition of a Codex-sized task

Each task in this plan has one primary outcome, a bounded set of files or components, explicit dependencies, and objective acceptance checks. If implementation reveals that a task needs multiple unrelated design decisions or cannot be verified independently, split it before continuing and update this plan.

## Phase map

| Phase | Outcome | Depends on | Plan |
| --- | --- | --- | --- |
| 0 | Deterministic TypeScript/SQLite foundation | None | [Phase 0](docs/project-plan/phase-0-foundation.md) |
| 1 | Idempotent historical source ingestion | Phase 0 | [Phase 1](docs/project-plan/phase-1-historical-ingestion.md) |
| 2 | Auditable identities and conservative reconciliation | Phase 1 | [Phase 2](docs/project-plan/phase-2-identity-reconciliation.md) |
| 3 | Safe incremental Last.fm synchronization | Phase 2 | [Phase 3](docs/project-plan/phase-3-lastfm-sync.md) |
| 4 | Reproducible initial analytical products | Phase 3 | [Phase 4](docs/project-plan/phase-4-initial-analytics.md) |
| 5 | Coverage-aware genre enrichment and eras | Phase 4 | [Phase 5](docs/project-plan/phase-5-genre-enrichment.md) |
| 6 | Visualization and artifact layer over stable contracts | Phase 5 core contract; genre UI may follow later | [Phase 6](docs/project-plan/phase-6-visualization.md) |

## Cross-phase dependency path

```text
toolchain and configuration
  -> database and migrations
  -> source evidence import
  -> canonical identity and events
  -> cross-source reconciliation
  -> incremental synchronization
  -> analytical contracts and exports
  -> optional enrichment
  -> visualization and artifacts
```

## Global invariants

Every implementation task must preserve the following:

- Files under `data/inputs` are read-only evidence and are never rewritten.
- The generated SQLite database is disposable and reproducible from migrations, inputs, versioned rules, and exported manual decisions.
- Every canonical listening event has source provenance; source evidence is not deleted when events are merged.
- Ambiguous evidence remains separate and inspectable. Strong-identifier conflicts are never merged automatically.
- Private or excluded fields do not enter SQLite, logs, errors, fixtures, reports, or generated artifacts.
- Canonical time is an unambiguous UTC instant; calendar grouping always names a presentation timezone and defaults to `America/Chicago`.
- Full-history play counts remain distinct from Spotify-only duration metrics.
- Commands are idempotent where promised, transactional, scriptable, and able to emit structured summaries.
- Analyses report coverage, parameters, versions, uncertainty, and as-of dates where applicable.

## Repository-wide quality gate

The exact scripts are established in Phase 0. From that point onward, a task is not complete unless all applicable checks pass:

- dependency and runtime configuration is valid;
- TypeScript type checking passes in strict mode;
- formatting and lint checks pass;
- unit and integration tests pass;
- migrations apply cleanly to an empty temporary database;
- SQLite foreign-key and integrity checks pass for database-changing tasks;
- no private input, generated database, secret, or sensitive source field is added to Git.

Full-archive checks are local-only. CI must use committed synthetic fixtures.

## Decision checkpoints

These decisions should be made only at the named point, with the choice and rationale recorded:

| Decision | Earliest point | Required evidence |
| --- | --- | --- |
| Timestamp storage representation | Phase 0, before the initial schema | Source precision, SQLite arithmetic, serialization tests |
| Focused runtime-validation and CLI libraries | Phase 0 | Small dependency surface and boundary-validation needs |
| Reconciliation thresholds | Phase 2 | Labeled overlap sample and false-merge bias |
| Manual-decision artifact format/location | Phase 2 | Rebuild, privacy, and versioning workflow |
| Last.fm retry/rate defaults | Phase 3 | API behavior and deterministic client tests |
| Era/rediscovery/abandonment defaults | Phase 4 | Documented analytical definitions and sensitivity examples |
| Genre providers and taxonomy | Phase 5 | Licensing, cacheability, coverage, provenance, and quality |
| Web framework and visualization libraries | Phase 6 | Stable analytical contracts and local-first deployment needs |

## Final completion criteria

The initial project mission is fulfilled when:

1. The database can be deleted and rebuilt deterministically from immutable inputs and committed project artifacts.
2. Historical Spotify and Last.fm track evidence is imported repeatably, with unsupported and rejected records safely reported.
3. Canonical events retain complete provenance and conservative, explainable reconciliation decisions.
4. Incremental Last.fm synchronization is idempotent and failure-safe.
5. Listening volume, artist eras, rediscovery, abandonment, and coverage reports are reproducible and disclose limitations.
6. Genre-era results, when enabled, disclose provider, taxonomy, weighting, freshness, and coverage.
7. Visualizations consume stable analytical outputs and visibly communicate gaps and uncertainty.
