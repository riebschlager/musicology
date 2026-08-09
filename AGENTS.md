# Repository guidance

## Authority and task scope

- `PROJECT_APPROACH.md` is authoritative for the mission, product intent, architecture, design
  principles, and confirmed technology direction.
- `PROJECT_PLAN.md` is authoritative for phase ordering, global invariants, quality gates, and
  decision checkpoints.
- The matching document under `docs/project-plan/` is authoritative for a numbered task's scope,
  dependencies, acceptance criteria, and phase gate.
- Existing code, migrations, configuration, and focused documentation describe the implemented
  state. Reconcile them with the plans before changing behavior; report material conflicts rather
  than silently choosing one.
- Normally implement one numbered plan task at a time. Treat it as a review boundary, satisfy its
  dependencies and acceptance criteria, and do not start later tasks or opportunistic future-phase
  work unless asked.
- If a task grows into unrelated outcomes or requires a deferred decision early, stop and propose a
  plan update instead of silently expanding scope.

## Before editing

- Inspect the repository structure, Git status, applicable `AGENTS.md` files, current configuration,
  and the files relevant to the requested task.
- Preserve user changes and work around unrelated modifications. Do not rewrite or clean up files
  outside the task merely for consistency.
- Confirm that plan assumptions still match the implementation and that the preceding task or phase
  gate is satisfied.

## Runtime preflight

- Before running Node-based commands, verify that the active runtime satisfies the repository's
  pinned Node.js 24 and pnpm 9 versions by checking `node --version`, `pnpm --version`, and the
  version-management configuration in `package.json`.
- When the active runtime does not match, do not run package scripts or native-module commands with
  it. Switch to the pinned runtime first; reinstall or rebuild dependencies only if that remains
  necessary.
- Treat native dependencies, including `better-sqlite3`, as runtime/ABI-sensitive. If one fails to
  load because it was built for another Node ABI, report the mismatch and use the project-pinned
  runtime rather than changing application code.
- Prefer the repository's Volta-managed runtime for verification commands when the shell runtime is
  uncertain.

## Technical direction

- Keep the system local-first: ingestion, reconciliation, analysis, and initial visualization must
  not require a hosted database or service.
- Maintain a single pnpm package unless a later documented decision demonstrates another boundary.
- Use TypeScript, Node.js 24, pnpm, ECMAScript modules, strict TypeScript, and SQLite. Preserve the
  repository pins, lockfile, small dependency surface, runtime validation at external boundaries,
  and project-owned adapter boundaries.
- Prefer explicit, inspectable SQL and composable command-line workflows. Keep canonical data
  rebuildable from inputs, migrations, versioned rules, and portable manual decisions.

## Data and privacy boundaries

- Treat everything under `data/inputs` as immutable private source evidence: read only, never
  rewrite, rename, normalize in place, delete, or use as committed test data.
- Never commit private inputs, private archive records, generated databases, SQLite sidecars, local
  secrets, or privacy-unreviewed generated outputs.
- Project only allowlisted fields across external boundaries. IP addresses, account usernames copied
  from private exports, source user-agent strings, secrets (including API keys), Spotify country,
  Spotify platform/device context, and raw rejected payloads must never enter SQLite, logs, errors,
  rejection diagnostics, fixtures, reports, Git, or generated outputs.
- Do not echo configuration values or unfiltered source/API payloads. Diagnostics must use safe error
  codes, locations, counts, and sanitized summaries.
- CI and committed tests use small deterministic synthetic fixtures. Full-archive imports,
  calibration, smoke tests, and performance checks remain local and report only aggregate,
  non-sensitive findings.

## Data semantics and invariants

- Keep these layers distinct:
  - source evidence: immutable, source-shaped observations and provenance;
  - canonical data: the current reproducible interpretation of identities and listening events;
  - reconciliation conclusions: versioned, auditable matches, candidates, scores, and decisions;
  - analytical results: derived, coverage-aware, parameterized, versioned outputs.
- Never delete source evidence because records are duplicated or merged. Every canonical event must
  retain one or more source links.
- Reconcile conservatively. Strong-identifier conflicts never auto-merge; ambiguous evidence stays
  separate and inspectable. Preserve feature-level evidence, rule versions, uncertainty, and
  superseded conclusions.
- Preserve original display text separately from matching normalization. Unknown data remains
  unknown; do not invent values.
- Make imports, migrations, synchronization, reconciliation, and deterministic exports idempotent
  where promised. Use stable fingerprints, uniqueness constraints, transactions, and explicit
  versions so unchanged reruns are no-ops and rebuilds are reproducible.
- Store domain timestamps as the established unambiguous UTC representation. Calendar operations
  must always receive an explicit IANA presentation timezone; default to `America/Chicago`, never
  the machine's implicit timezone.
- Keep full-history canonical play counts distinct from Spotify-backed duration, completion, or skip
  metrics. Analytical outputs must disclose definitions, parameters, sources, coverage, unresolved
  data, versions, timezone, uncertainty, and as-of date where relevant.

## Schema and migrations

- Change schema only through ordered, committed SQL migrations and update schema contract tests and
  focused documentation in the same task.
- Never edit, rename, remove, or reorder an applied migration; add a new migration. Preserve checksum
  validation, transactional application, repeat no-op behavior, and migration history.
- Use explicit foreign keys, constraints, indexes, and safe enumerated checks to enforce known
  invariants. Keep privacy exclusions enforceable by schema allowlists, not convention alone.
- Keep SQLite behind the project-owned database interface, enable foreign keys on every connection,
  wrap multi-step writes in transactions, and run integrity and foreign-key checks for relevant
  changes.
- Avoid speculative schema or analytical materialization that belongs to a later numbered task.

## Tests and verification

- Add or update tests in the same task as every behavioral change. Cover happy paths, boundaries,
  failures, rollback or retry behavior, privacy redaction, idempotent reruns, and deterministic output
  as applicable.
- Use synthetic fixtures sufficient for unit, integration, schema-contract, and CI verification.
  Never make CI depend on `data/inputs`, credentials, live APIs, or a private database.
- Before running commands, inspect `package.json`, repository configuration, and relevant developer
  documentation for the current supported scripts; do not invent command names.
- Phase 0 currently establishes `pnpm quality` as the aggregate gate and `pnpm db:migrate` plus
  `pnpm db:status` for migration verification. Run the task-level checks and the full applicable gate.
  For database changes, also migrate and validate a fresh temporary database.
- If stable scripts are absent on another branch, report that and use only commands supported by its
  configuration. Update this file when Phase 0 establishes or materially changes stable scripts.
- Do not use private full-archive success as a substitute for deterministic fixture tests; run local
  archive checks only when the task calls for them and local data is available.

## Documentation and decisions

- Update focused documentation when commands, configuration, schema, public contracts, data handling,
  or developer workflow changes.
- Record material schema, normalization, reconciliation, metric, provider, taxonomy, output-contract,
  or framework decisions in the repository at the checkpoint named by the plan. Include rationale,
  alternatives, versioning/migration impact, and privacy implications without secrets or private data.
- Refer to planning documents instead of copying their task lists into code or documentation.

## Handoff and Git discipline

- Report the numbered task completed, files changed, acceptance criteria addressed, verification
  commands and results, assumptions, deviations, remaining risks, and blockers. Clearly distinguish
  skipped checks from passing checks.
- Do not commit, push, create or switch branches, stage changes, or modify unrelated files unless the
  user explicitly asks. Keep Git changes limited to the requested task.
