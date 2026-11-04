# Design

## Context

`expressions.added_week` (TEXT, indexed by `idx_expr_week`) drives three things today: the week-mode archive scope, the overwrite condition, and the "newest week first" ordering of new items. The vault change `switch-to-unit-files` replaces it with `unit` and `position` in payload version 4. Motivation is in proposal.md.

## Goals / Non-Goals

**Goals:**

- Keep every expression `id` and all per-user review state through the switch.
- Do the switch with one migration and one full sync.

**Non-Goals:**

- Accepting version 3 and version 4 at the same time. There is one admin and one vault, so a short window where syncs fail is acceptable.

## Decisions

### Migration (migrations/0002_unit.sql)

```sql
DROP INDEX IF EXISTS idx_expr_week;
ALTER TABLE expressions ADD COLUMN unit INTEGER NOT NULL DEFAULT 0;     -- 0 = not yet synced as a unit
ALTER TABLE expressions ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE expressions DROP COLUMN added_week;
CREATE INDEX idx_expr_unit ON expressions(unit, archived);
CREATE INDEX idx_expr_course ON expressions(archived, unit, position);
```

- The index on `added_week` must be dropped before SQLite allows `DROP COLUMN`.
- Existing rows get `unit = 0` and `position = 0`. Valid payloads never contain 0, so the first `all` sync after the deploy marks every surviving expression as `updated` and fills in the real values.
- The defaults avoid a table rebuild. `card_state` and `session_items` reference `expressions(id)`, which is untouched.

### Payload validation

The version is checked first, so a version-3 payload gets a clear message: `unsupported payload version 3, expected 4`. `unit` values must be safe integers ≥ 1. `position` must be an integer ≥ 1.

### Classification and archive scope

- Classification compares the tuple `(content_hash, unit, position)` and the `archived` flag. A moved or reordered item becomes an `update`, not a re-insert, so its statistics stay.
- Archive scope SQL in unit mode: `SELECT id FROM expressions WHERE archived = 0 AND unit = ?`, minus the payload ids.

### Fresh-candidate ordering

In `src/review.ts`, the fresh query changes from `ORDER BY added_week DESC` to `ORDER BY e.unit ASC, e.position ASC`, using `idx_expr_course`. `selectBatch` keeps the input order of `fresh`, so no change is needed in `srs.ts` beyond the tests.

### Report

The `week` field in the report is replaced by `unit`, which is null in `all` mode.

## Risks / Trade-offs

- [Between the migration and the first unit sync, every row has `unit = 0`, so the new-item order is arbitrary] → run the vault `all` sync right after deploying. The window is minutes, and batches only run at even hours.
- [The vault pushes version 3 after this deploy] → 422 with a clear message. The vault Action goes red, and nothing changes.
- [`DROP COLUMN` unsupported] → D1 runs a recent SQLite (3.35 or later). If the migration fails on `wrangler d1 migrations apply --local`, fall back to a table rebuild in the same migration.

## Migration Plan

1. `wrangler d1 migrations apply expression-drill --local`, then run the tests.
2. `wrangler d1 migrations apply expression-drill --remote`, then `wrangler deploy`.
3. Push the vault change (renamed `unit-01.md`). The `all` sync should report `updated` = item count and `archived: 0`.
4. Check: `wrangler d1 execute expression-drill --remote --command "SELECT unit, COUNT(*) FROM expressions WHERE archived = 0 GROUP BY unit"`.

Rollback: there is no down-migration. Redeploying the old Worker would fail on the missing `added_week`. If needed, write `0003` to re-add `added_week` and redeploy both repos' previous versions.
