# Proposal

## Why

Eight batches of up to 10 expressions a day are too many interruptions. Four larger batches, every 5 hours from 07:00 to 22:00, fit the day better and still bring missed expressions back the same day.

## What Changes

- Batches go out at local hours 07:00, 12:00, 17:00 and 22:00 instead of every even hour from 08:00 to 22:00. The hours are configurable with `BATCH_HOURS`.
- A batch holds up to 15 expressions instead of 10 (`BATCH_MAX = 15`). The minimum stays at 5.
- The drill reminder button moves from the 20:00 batch (which no longer exists) to the 17:00 batch, configurable with `DRILL_REMINDER_HOUR`.
- Quiet hours end at 07:00 instead of 08:00, so items due overnight are ready for the first batch.

Unchanged: the hourly cron trigger, the spoiler message, grading, Leitner intervals, `NEW_PER_BATCH` (3) and `NEW_PER_DAY` (20).

Out of scope:

- Per-user batch hours or batch size.
- Changing the box intervals. Box 1 (4 hours) still lands a miss in the next batch, 5 hours later.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `scheduled-review`: batch hours, drill reminder hour, and scenario times in message format and open-batch closing.
- `spaced-repetition`: quiet hours end at 07:00, batch maximum is 15, and repeat-exclusion scenario times change.
- `reflex-drill`: the drill-summary scenario refers to the drill-reminder batch instead of 20:00.

## Impact

- `wrangler.toml` `[vars]`: `BATCH_MAX = "15"`, new `BATCH_HOURS = "7,12,17,22"` and `DRILL_REMINDER_HOUR = "17"`.
- `src/index.ts` (`scheduled()` hour filter), `src/srs.ts` (`nextDue` quiet hours), `src/review.ts` (drill button hour), plus tests.
- No schema change.
