# Design

## Context

`scheduled()` runs every hour and sends a batch when the user's local hour is even and between 8 and 22. `selectBatch` uses `max = BATCH_MAX` (10). `nextDue` moves due times in the 22:00–08:00 window to 08:00. The 20:00 batch carries the drill button. Motivation is in proposal.md.

## Goals / Non-Goals

**Goals:**

- Move every hard-coded schedule value into `[vars]`, so future tuning is a config change plus a deploy.

**Non-Goals:**

- Per-user schedules.

## Decisions

### Config

```toml
[vars]
BATCH_HOURS = "7,12,17,22"
BATCH_MIN = "5"
BATCH_MAX = "15"
DRILL_REMINDER_HOUR = "17"
QUIET_START_HOUR = "22"   # due times after this hour…
QUIET_END_HOUR = "7"      # …or before this hour move to QUIET_END_HOUR next morning
```

Parse these once per invocation in a `config.ts` helper that validates the values, for example that the hours are 0–23 and that `BATCH_MAX ≥ BATCH_MIN`. Invalid config throws at startup, and tests cover the parser.

### Cron

Keep the hourly cron `0 * * * *`. The filter becomes `BATCH_HOURS.includes(localHour)`. With 4 batch hours, 20 of the 24 runs per day exit immediately, which costs nothing on the free plan.

Alternative considered: a cron listing only the UTC equivalents of the batch hours. Rejected, because users can have different `tz_offset_min` values.

### Quiet hours in `nextDue`

`nextDue(now, box, tzMin, quiet)` takes the quiet window as a parameter instead of using constants. A due time strictly after `QUIET_START_HOUR:00`, or before `QUIET_END_HOUR:00`, moves to `QUIET_END_HOUR:00` on the next local morning (the same calendar day when it is already past midnight).

### Interaction with intervals

- A miss at 07:00 is due at 11:00 and appears at 12:00. A miss at 22:00 is due at 02:00, which moves to 07:00.
- With 15 items per batch and only 3 new items per batch, a day brings at most 12 new expressions (4 × 3), below the cap of 20. To use the full daily cap, raise `NEW_PER_BATCH` to 5. That is a config change and needs no spec change.

## Risks / Trade-offs

- [15 items make the message long on small phones] → 15 short cue lines plus 3 keyboard rows of 5 buttons still fit in one Telegram message, far below the 4096-character limit for typical cues.
- [Open batches from the old schedule at deploy time] → they are closed as `skip` by the next batch, as usual.

## Migration Plan

Update `[vars]` and deploy. The next batch-hour run uses the new schedule. Rollback: restore the old vars and redeploy.
