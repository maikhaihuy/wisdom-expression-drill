# Tasks

## 1. Config

- [x] 1.1 Add `src/config.ts` to parse and validate `BATCH_HOURS`, `BATCH_MIN`, `BATCH_MAX`, `DRILL_REMINDER_HOUR`, `QUIET_START_HOUR` and `QUIET_END_HOUR` with the defaults from design.md, and verify unit tests for valid input, defaults, an out-of-range hour, and `BATCH_MAX < BATCH_MIN`
- [x] 1.2 Update `[vars]` in `wrangler.toml` (`BATCH_MAX = "15"`, the new vars), and verify that `wrangler deploy --dry-run` succeeds

## 2. Schedule

- [x] 2.1 Change the `scheduled()` hour filter to `BATCH_HOURS`, and verify tests at 00:00, 03:00, 05:00, 15:00 and 16:00 UTC for a UTC+7 user (batches at 07:00, 12:00 and 22:00 local only)
- [x] 2.2 Move the drill button to `DRILL_REMINDER_HOUR`, and verify tests for "No drill today" and "Already drilled" at 17:00
- [x] 2.3 Update the "Ignored batch" and "Rendering" tests to the 07:00/12:00 times and a 15-item batch, and verify they pass

## 3. Selection and quiet hours

- [x] 3.1 Make `nextDue` take the quiet window from config, and verify that a test where a miss at 22:00 local becomes due at 07:00 local passes
- [x] 3.2 Pass `BATCH_MAX` from config into `selectBatch`, and verify that the "Many due items" test (20 due → 15) and the 07:00/12:00/17:00 "Skipped item stays due" test pass

## 4. Rollout

- [ ] 4.1 Deploy, and verify that `wrangler tail` shows batches sent only at 07:00, 12:00, 17:00 and 22:00 local over one day, and that a batch contains up to 15 items

## Workflow follow-up

- Archive with `openspec archive retune-batch-schedule` after one day on the new schedule.
