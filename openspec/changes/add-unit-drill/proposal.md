# Proposal

## Why

The reflex drill always pulls from every learned expression, weighted toward the hardest and the due ones. After finishing a course unit, a learner wants to consolidate exactly that unit with fast recall, and today there is no way to aim the drill at it.

## What Changes

- The Mini App opens on a picker: "Tất cả" (the existing drill, unchanged) plus one row per course unit showing `learned / total` for the user. Units with nothing learned are shown disabled. The most recent unit with learned expressions is listed first.
- A unit drill uses only the user's learned expressions (box ≥ 1) from that unit, shuffled, up to `DRILL_DECK_SIZE`. The 50/30/20 hard/due/random mix applies only to "Tất cả".
- A unit drill ends when `DRILL_SECONDS` elapse or the deck (including retries of missed cards) runs out, whichever comes first. This is the current behaviour of the drill; the start screen describes the time as a limit ("tối đa 5 phút").
- Timing, self-grading, retries of missed cards, answer submission and review state updates work as they do now.
- A session remembers which unit it drilled. The summary (in the Mini App and in chat) names the unit.
- Only a "Tất cả" drill sets `last_drill_date`, so a unit drill does not hide the 20:00 drill button.
- `/drill N` replies with a button that opens the unit drill for unit N directly, skipping the picker. `/drill` without an argument behaves as before and opens the picker.
- New drill API action `units` returns the per-unit counts; `start` accepts an optional `unit`.

### Out of scope

- Drilling unlearned (box 0) expressions, or a "practice only" mode that does not touch review state.
- A drill button attached to the batch that completes a unit.
- Per-unit figures in `/stats` or `/hard`.
- Any change to the sync payload or the `english-vault` repo.
- Repeating the unit deck once it runs out before time is up.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `reflex-drill`: deck composition gains a unit-scoped mode; a unit picker is added; the session records its unit; the summary names the unit; `last_drill_date` is set only by the all-units drill; the time limit is an upper bound.
- `bot-commands`: `/drill` accepts an optional unit number.

## Impact

- **Code**: `src/drill-api.ts` (new `units` action, `start` body with `unit`, `finish` summary and `last_drill_date` rule), `src/srs.ts` (pure unit-deck selection), `src/commands.ts` and `src/i18n.ts` (`/drill N`, texts), `public/drill/*` (picker screen, `?unit=` handling, start-screen wording).
- **D1**: new migration `migrations/0003_session_unit.sql` adding a nullable `sessions.unit`.
- **API**: `POST /api/drill/units` added; `POST /api/drill/start` accepts `{ unit?: number }`. Requests without a body keep working unchanged.
- **Tests**: `test/drill-api.test.ts`, `test/srs.test.ts`, `test/commands.test.ts`.
