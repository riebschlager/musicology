# Phase 2: Identity and reconciliation

## Summary

- Adds versioned identity normalization, conservative resolution, canonical events, duplicate
  collapse, bounded cross-source candidates, explainable features, policy decisions, and portable
  manual decisions.
- Adds the transactional `reconcile` workflow, including dry-run rollback and repeat-run no-op
  behavior.
- Extends canonical validation and coverage reporting with source backing, merge, unresolved, and
  overlap metrics.

## Verification

- `pnpm quality`
- Fresh-database migration, SQLite integrity, and foreign-key checks
- Synthetic import/repeat-import, reconciliation, manual-decision, and privacy tests
- Local aggregate archive reconciliation, validation, coverage, and repeat-run checks

## Privacy

The implementation keeps source inputs immutable, uses allowlisted source fields, and emits only
aggregate reconciliation and coverage summaries. Generated databases and local review artifacts
remain ignored.
