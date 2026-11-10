# Tasks

## 0. Prerequisite

- [x] 0.1 Archive `add-unit-drill` (`/opsx:archive add-unit-drill`) so `openspec/specs/reflex-drill/spec.md` contains "Drill scope picker" and "Unit deck composition"; verify with `grep -n "Drill scope picker" openspec/specs/reflex-drill/spec.md`

## 1. Pure selection

- [x] 1.1 Add `selectPracticeDeck(cards, size, rng)` to `src/srs.ts` (shuffle, cap at `size`, no box filter); verify with new cases in `test/srs.test.ts`: box-0 and learned cards both included, cap at size, deterministic order under a fixed rng, empty input gives an empty deck

## 2. Drill API

- [x] 2.1 Add the read-only `practice` action to `handleDrillApi`: body `{ unit }` required (422 `invalid_unit` for missing, `null` or non-positive-integer), active expressions of the unit via `selectPracticeDeck`, 409 `empty_unit` when there are none, response `{ unit, cardSeconds, totalSeconds, cards }` with no `sessionId`; verify in `test/drill-api.test.ts`: unlearned unit returns all 22, partly learned returns all 18, archived excluded, empty unit → 409, invalid unit → 422, bad init data → 401, and `sessions`, `session_items`, `card_state` and `users.last_drill_date` are unchanged after the call
- [x] 2.2 Add `unitTotal` to the `start` response for a unit drill (absent for all units); verify in `test/drill-api.test.ts` that a unit 5 drill with 6 of 18 learned returns 6 cards and `unitTotal: 18`, and existing start tests still pass

## 3. Mini App

- [x] 3.1 Picker: rows with `learned = 0` become tappable, labelled "Chưa học · luyện thử", and call `practice(unit)`; verify with `npm run dev` and test init data that unit 6 in the seeded picker opens the practice start screen
- [x] 3.2 Practice run: `practice(unit)` loads the deck, sets the practice flag, shows the "Unit N" and "Luyện thử · không lưu" tags; `enqueue`/`flush` are skipped and `finish` builds the summary locally; verify with `npm run dev`: run a practice of unit 6 to the end and check the summary, then check in the local D1 that no session or answer was added and `card_state` is unchanged
- [x] 3.3 Start screen of a unit drill shows "Luyện thử cả unit (N cụm)" when `unitTotal` is larger than the deck; verify with `npm run dev` on unit 5 (6/18): the link appears and starts practice with 18 cards; unit 4 (20/20) shows no link
- [x] 3.4 Message screen gains an optional second action; `no_learned_in_unit` shows "Luyện thử unit N" (primary) and "Chọn unit khác" (secondary), `empty_unit` shows "Chọn unit khác"; verify with `npm run dev` opening `/drill/?unit=6`

## 4. Integration

- [x] 4.1 Run `npm run typecheck` and `npm test`; both pass
- [x] 4.2 Update `README.md` (drill section and API table) to describe practice and `POST /api/drill/practice`; verify the wording matches the app's labels
- [x] 4.3 Compare the client-side summary with `summarizeDrill`: for one practice run, enter the same answers as a fixture in a `test/drill-api.test.ts` `summarizeDrill` case and check cards, accuracy and median match what the app showed
- [x] 4.4 Run `openspec validate add-practice-drill --strict`; it passes

## Workflow follow-up

- Deploy with `npm run deploy` (no migration needed).
- Archive the change with `/opsx:archive` once deployed and checked.
