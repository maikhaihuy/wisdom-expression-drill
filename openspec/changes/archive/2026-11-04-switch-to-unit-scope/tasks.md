# Tasks

## 1. Schema

- [x] 1.1 Add `migrations/0002_unit.sql` from design.md, and verify `wrangler d1 migrations apply expression-drill --local` succeeds and `PRAGMA table_info(expressions)` shows `unit` and `position` and no `added_week`

## 2. Sync

- [x] 2.1 Update payload validation for version 4 (`mode` all/unit, `unit`, item `unit` and `position`, clear message for version 3), and verify one test per scenario of "Payload version 4 validation"
- [x] 2.2 Update classification to compare `content_hash`, `unit` and `position`, and verify tests for edited content, a move to another unit, a reorder inside a unit, an archived item returning, and an identical item
- [x] 2.3 Update the archive scope to `unit` mode, and verify tests where a unit sync leaves other units untouched, a deleted bullet is archived, a deleted unit is archived in `all` mode, and statistics are kept
- [x] 2.4 Return `unit` instead of `week` in the report, and verify the report tests for both modes
- [x] 2.5 Replace every remaining `added_week` and `week` reference in `src/` and the tests, and verify that `grep -rn "added_week\|'week'" src test` finds nothing and `npm test` passes

## 3. Batch ordering

- [x] 3.1 Change the fresh-candidate query to `ORDER BY unit, position`, and verify with a test that the "New items in course order" scenario returns unit 1 positions 7–9 before any unit-2 item

## 4. Docs and rollout

- [x] 4.1 Update the `context` in `openspec/config.yaml` and the README to describe unit files and payload version 4, and verify that `grep -rn "YYYY-Www\|version 3\|added_week" README.md openspec/config.yaml` finds nothing
- [x] 4.2 Apply the migration remotely and deploy, then verify that a version-3 test payload gets 422 with the version message
- [x] 4.3 After the vault pushes `unit-01.md`, verify that the sync report shows `archived: 0` and that the `SELECT unit, COUNT(*)` query shows unit 1 with the full item count

## Workflow follow-up

- Archive with `openspec archive switch-to-unit-scope` after the first unit sync and one day of batches.
