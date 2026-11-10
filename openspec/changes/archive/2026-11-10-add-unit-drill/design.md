# Design

## Context

The drill API (`src/drill-api.ts`) routes `POST /api/drill/{start,answers,finish}`. It authenticates every call from `X-Init-Data` and rejects any other action or method. `start` takes no body. It loads up to 500 learned cards across all units, picks a deck with the pure `selectDrillDeck` (`src/srs.ts`) and inserts a `sessions` row with `kind = 'drill'`. `finish` closes the session and sets `users.last_drill_date` in the same batch. The 20:00 batch uses that column to decide whether to attach the drill button.

The Mini App (`public/drill/app.js`) calls `start` as soon as it loads and shows a start screen with "N phút · M cụm". Its `nextCard()` already finishes the drill when the queue is empty, so the drill already ends on time-up or on running out of cards.

Expressions carry `unit` (≥ 1 once synced, 0 before) and `position`, with index `idx_expr_unit(unit, archived)`.

## Goals / Non-Goals

**Goals:**
- Add a unit-scoped drill without changing the behaviour or response shape of the all-units drill.
- Keep deck selection a pure, unit-testable function.
- Keep the Mini App a single static page with no extra library.

**Non-Goals:**
- Server-side checks that answers in a unit session belong to that unit. Answers are still limited to the user's own learned expressions, so a modified client gains nothing beyond what it could already do.
- Caching the unit counts. At tens of users, one grouped query per Mini App open is cheap.

## Decisions

### D1. Unit scope is a nullable column on `sessions`
Migration `migrations/0003_session_unit.sql`: `ALTER TABLE sessions ADD COLUMN unit INTEGER;`. `NULL` means all units. Batch sessions leave it `NULL`.
- *Why*: `finish` runs in a later request and needs the unit for the summary and for the `last_drill_date` rule. Storing it with the session is the only trustworthy source, because the client can't be trusted to repeat it.
- *Alternative*: a new `kind = 'unit_drill'`. Rejected because the `CHECK` constraint on `kind` would mean rebuilding the table, and every existing `kind = 'drill'` check would have to change.

### D2. `start` accepts an optional JSON body `{ unit }`
A missing or empty body, or `unit` absent or `null`, starts the all-units drill exactly as today. Anything other than a positive integer gets 422 `invalid_unit`. A valid unit with no learned cards gets 409 `no_learned_in_unit`. The response adds `unit: number | null`. Otherwise it is unchanged.

### D3. Unit deck is a separate pure function
`selectUnitDeck(cards, size, rng)` in `src/srs.ts` filters to box ≥ 1, shuffles and truncates to `size`. The SQL already restricts rows to `e.unit = ? AND e.archived = 0 AND c.box >= 1`. The function still filters, so tests can pass mixed fixtures.
- *Why not reuse `selectDrillDeck`*: its hard, due and random groups exist to choose a deck from hundreds of cards. For one unit, the deck is the whole unit.

### D4. `units` action: `POST /api/drill/units`
It returns `{ units: [{ unit, learned, total }] }`, ordered as the picker shows them. It is computed with one grouped query over active expressions with `unit >= 1`, left-joined to the user's `card_state`. The ordering (learned units newest first, then unlearned units) lives in a small pure function so it can be tested.
- *Why POST*: the router accepts only POST and every call carries the same header auth. A GET would need a second method path for no benefit.

### D5. `finish` uses the stored unit
`finish` reads `sessions.unit`. The `UPDATE users SET last_drill_date …` statement gains `AND unit IS NULL` in its `EXISTS` subquery, so it stays in the same atomic batch. The JSON summary adds `unit`. `renderDrillSummary` puts a unit header line first when `unit` is set.

### D6. Mini App flow
```
load ─┬─ ?unit=N in URL ──────────────▶ start({unit:N}) ─▶ start screen ─▶ drill
      └─ no unit ─▶ units() ─▶ picker ─┬─ "Tất cả" ─▶ start({})      ─┘
                                        └─ Unit N  ─▶ start({unit:N}) ─┘
```
- The picker is a new `screen-picker` section. Disabled rows are rendered but can't be tapped.
- The start-screen text becomes "tối đa N phút · M cụm" for both modes, with "Unit N" as a heading for a unit drill.
- A `no_learned_in_unit` error shows a message with a "Chọn unit khác" action that returns to the picker. It shows no "Đóng" action.
- The drill loop is unchanged. Ending when the queue is empty is the existing behaviour.

### D7. `/drill N` builds the URL with `?unit=N`
`drillRow(url)` already takes a URL, so `/drill N` passes `${drillUrl}?unit=N`. Telegram keeps the query string of a `web_app` button URL. The argument parsing is pure (`parseUnitArg`): `""` → all units, positive integer → unit, anything else → usage text.

## Risks / Trade-offs

- [The client sends a unit that exists in the URL but was later removed from the bank] → `start` gets 409 `no_learned_in_unit` and the Mini App offers the picker.
- [An old cached `app.js` calls `start` without a body after deploy] → that is still the all-units drill, so there's no breakage.
- [The `units` query scans all of the user's `card_state` rows] → bounded by bank size (hundreds to low thousands) and covered by the existing indexes. That's acceptable on the free plan.
- [`DRILL_DECK_SIZE` smaller than a unit] → the deck is a random subset and the start screen shows the real card count. Units are expected to be well below 60.

## Migration Plan

1. Apply `0003_session_unit.sql` (`wrangler d1 migrations apply`). Adding a nullable column doesn't affect existing rows or code.
2. Deploy the Worker and the static assets together.
3. Rollback: redeploy the previous Worker. The extra column is ignored by old code and does not need to be dropped.
