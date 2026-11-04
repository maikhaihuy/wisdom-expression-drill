# Proposal

## Why

The vault now organises expressions by course unit (`unit-NN.md`) instead of calendar week (change `switch-to-unit-files` in `english-vault`). The Worker must store the unit and the order inside it, sync one unit at a time, and introduce new expressions in course order: unit 1 before unit 2.

## What Changes

- **BREAKING** `POST /admin/sync` accepts payload version 4 only. `mode` is `all` or `unit`, the top-level `unit` replaces `week`, and items carry `unit` (integer) and `position` (1-based order inside the unit). Version 3 gets 422.
- Migration `0002_unit.sql` replaces `expressions.added_week` with `unit` and `position`.
- Reconciliation compares `unit` and `position` as well as `content_hash`. In `unit` mode, the archive scope is the expressions of that unit.
- The sync result report returns `unit` instead of `week`.
- New expressions enter batches in course order: lowest `unit` first, then lowest `position`.

Out of scope:

- Showing unit numbers or names in bot messages.
- Per-user unit progress or unlocking (all units are available at once, limited only by the new-per-day rules).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bank-sync`: the payload, the overwrite condition, the archive scope and the report move from `week`/`added_week` to `unit`/`position`.
- `spaced-repetition`: new expressions are ordered by unit and position instead of newest week first.

## Impact

- `migrations/0002_unit.sql`, `src/sync.ts`, `src/db.ts`, `src/review.ts` (fresh-candidate query), plus tests and fixtures.
- `openspec/config.yaml` context (payload version 4, unit files).
- Deploy before the vault change. Vault syncs fail with 422 until both sides are on version 4.
