# Design

## Context

After `add-unit-drill`, the drill API (`src/drill-api.ts`) has `units`, `start` (optional `{ unit }`), `answers` and `finish`. Every drill is a `sessions` row, its answers update `card_state` and `finish` sends a chat summary. The Mini App (`public/drill/app.js`) has a picker that disables units with nothing learned, a start screen, the card loop and a summary screen. It buffers answers and flushes them to `answers`, then calls `finish`.

`summarizeDrill` (pure, in `src/drill-api.ts`) computes cards, first-try accuracy, median latency and missed expressions from first tries.

See proposal.md for why practice exists and what it must not touch.

## Goals / Non-Goals

**Goals:**
- Practice reuses the card loop as it is; only where the deck comes from and where results go are different.
- Practice is guaranteed not to write, by construction rather than by flags on write paths.

**Non-Goals:**
- Sharing summary code between the Worker and the Mini App. The Mini App has no build step, so the client keeps its own small copy of the summary logic.

## Decisions

### D1. A separate read-only action, not a flag on `start`
`POST /api/drill/practice` with body `{ unit }`. It authenticates like every drill action, reads the unit's active expressions and returns `{ unit, cardSeconds, totalSeconds, cards }`. It returns no `sessionId` and runs no write statement. Errors: 422 `invalid_unit` when `unit` is missing, `null` or not a positive integer; 409 `empty_unit` when the unit has no active expressions.
- *Why*: with no session there is nothing `answers` or `finish` can attach to, so practice can't write even if the client misbehaves. A `practice: true` flag on `start` would need a session (or a special case in every write path) to keep the same guarantee.
- *Alternative*: a `kind = 'practice'` session with answers stored but not applied. Rejected because the proposal says nothing is kept, and the `CHECK` on `kind` would need a table rebuild.

### D2. Pure deck selection
`selectPracticeDeck(cards, size, rng)` in `src/srs.ts` shuffles and truncates to `size`. The SQL filters by `unit = ? AND archived = 0`. No `card_state` join is needed, because learned status doesn't matter for practice.

### D3. `start` reports the unit's total
For a unit drill, the `start` response adds `unitTotal`, the number of active expressions in the unit. This is an additive field. The start screen shows "Luyện thử cả unit (N cụm)" when `unitTotal` is greater than the deck size. This works the same whether the app came from the picker or from `/drill N`, where the picker data was never loaded.
- *Alternative*: have the client call `units` on a direct link too. Rejected: an extra request just for one number.

### D4. Mini App: a practice flag on the in-memory run
`practice(unit)` loads the deck and sets `run.practice = true`. With that flag:
- `enqueue` and `flush` do nothing, and `finish` skips the network and builds the summary locally from the graded answers it already keeps (first try per expression, the same rules as `summarizeDrill`).
- The start screen and summary show a "Luyện thử · không lưu" tag next to "Unit N".
- Everything else (timer, countdown, reveal, grading, retries of missed cards, keyboard and swipe) is unchanged.

Entry points:
```
picker ─┬─ unit with learned > 0 ─▶ start({unit}) ─▶ start screen ─┬─ Bắt đầu ─▶ drill
        │                                                           └─ "Luyện thử cả unit" ─▶ practice(unit)
        └─ unit with learned = 0 ─▶ practice(unit) ─▶ start screen (practice) ─▶ drill
/drill N ─▶ start({unit}) ─409 no_learned_in_unit─▶ message: "Luyện thử unit N" | "Chọn unit khác"
```
The message screen gains an optional second action, rendered as a link button, for the 409 case.

### D5. No server-side summary for practice
Nothing reaches the Worker after `practice` returns, so there is no chat message and no `last_drill_date` update. Both follow from D1 without extra code.

## Risks / Trade-offs

- [The user mistakes practice for a real drill and expects progress] → the "Luyện thử · không lưu" tag is on the picker row, the start screen and the summary.
- [The client-side summary drifts from `summarizeDrill`] → both follow the documented first-try rules. The client copy is about 15 lines; manual checks in task 4.3 compare it with a real drill on the same answers.
- [`practice` reveals the answers of unlearned expressions early] → that is the purpose of the feature. The bank is shared with every member already, and the endpoint still needs valid init data.
- [An old cached `app.js`] → it never calls `practice` and keeps the disabled rows. No breakage.

## Migration Plan

1. No D1 migration.
2. Deploy the Worker and static assets together (`npm run deploy`).
3. Rollback: redeploy the previous version. Nothing was stored, so there is nothing to clean up.
