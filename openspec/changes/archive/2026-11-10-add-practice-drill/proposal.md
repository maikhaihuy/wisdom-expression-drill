# Proposal

## Why

The unit drill only uses expressions the user has already learned, so a unit with nothing learned can't be drilled, and in a partly learned unit only the learned part can be. A learner who wants to rehearse a whole unit ahead of the batches, for example right after a class, has no way to do it today.

## What Changes

- New **practice mode** for one unit: a drill over every active expression in that unit, learned or not, shuffled, up to `DRILL_DECK_SIZE`. It uses the same cards, timing, self-grading and retries of missed cards as the reflex drill.
- Practice **writes nothing**. It creates no session, stores no answers, does not touch review state, `/stats`, `/hard` or `last_drill_date`, and introduces no new expressions. Closing the app loses the run, and that is fine.
- The summary (cards, first-try accuracy, median latency, missed expressions) is shown only in the Mini App, marked as practice that was not saved. No chat message is sent.
- Entry points in the Mini App:
  - In the picker, a unit with nothing learned is no longer disabled. Tapping it opens practice for that unit.
  - The start screen of a unit drill for a partly learned unit offers "practise the whole unit".
  - When a unit drill can't start because nothing in the unit is learned (for example from `/drill N`), the app offers practice for that unit.
- New drill API action `practice` returns the practice deck for a unit. It is read-only.

### Out of scope

- Any way for practice results to count: no review state, no box changes, no new-card introduction, no statistics.
- Practice across all units, or across several units at once.
- A bot command for practice. `/drill N` keeps opening the unit drill, which falls back to offering practice.
- Practice for expressions not yet assigned to a unit (`unit = 0`).
- Keeping or resuming a practice run after the app is closed.

### Depends on

`add-unit-drill`. This change modifies requirements that change adds, so `add-unit-drill` must be archived first.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `reflex-drill`: adds a practice mode for a unit that writes no state; picker rows for units with nothing learned open practice instead of being disabled; a unit drill with nothing learned offers practice instead of only pointing to batches.

## Impact

- **Code**: `src/drill-api.ts` (new read-only `practice` action), `src/srs.ts` (pure practice deck selection), `public/drill/*` (practice entry points, a client-side summary, a "not saved" marker).
- **D1**: no schema change and no writes from practice.
- **API**: `POST /api/drill/practice` with body `{ unit }` added. Existing actions are unchanged.
- **Tests**: `test/drill-api.test.ts`, `test/srs.test.ts`.
