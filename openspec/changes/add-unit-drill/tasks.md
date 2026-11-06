# Tasks

## 1. Schema

- [ ] 1.1 Add `migrations/0003_session_unit.sql` with a nullable `sessions.unit INTEGER` column (do not touch 0001/0002); verify `npm test` still passes, since `test/apply-migrations.ts` applies all migrations

## 2. Pure selection and ordering

- [ ] 2.1 Add `selectUnitDeck(cards, size, rng)` to `src/srs.ts` (box ≥ 1 only, shuffled, capped at `size`); verify with new cases in `test/srs.test.ts`: finished unit returns all cards, box-0 cards excluded, cap at size, deterministic order under a fixed rng
- [ ] 2.2 Add a pure ordering function for picker rows (units with learned > 0 newest first, then units with learned = 0, in course order); verify with a `test/srs.test.ts` (or `test/drill-api.test.ts`) case matching the "Picker after finishing unit 4" scenario

## 3. Drill API

- [ ] 3.1 Add the `units` action to `handleDrillApi`: one grouped query over active expressions with `unit >= 1`, left-joined to the caller's `card_state`, returning `{ units: [{ unit, learned, total }] }`; verify in `test/drill-api.test.ts` that counts are per user, archived and unit-0 expressions are excluded, and bad init data gets 401
- [ ] 3.2 Make `start` accept an optional body `{ unit }`: no body or `null` keeps today's path; a positive integer filters by `e.unit = ?` and uses `selectUnitDeck`; anything else gets 422 `invalid_unit`; no learned cards gets 409 `no_learned_in_unit`; store `unit` on the session and return it; verify in `test/drill-api.test.ts`: unit deck has only learned cards of that unit, partial unit, empty unit → 409 with no session, invalid unit → 422, no body still works (existing tests pass unchanged)
- [ ] 3.3 Make `finish` read `sessions.unit`: add `unit` to the JSON summary, put a unit line at the top of the chat summary (new `i18n` string), and set `last_drill_date` only when `unit IS NULL`; verify in `test/drill-api.test.ts` with the "Finished unit drill" scenario (summary names unit 4, 90%, `last_drill_date` unchanged, 20:00 batch still has the drill button) while the existing 48/40 test still passes

## 4. Bot command

- [ ] 4.1 Add pure `parseUnitArg` and make `/drill N` reply with the unit-specific text and a `web_app` button to `${drillUrl}?unit=N`; invalid arguments get a usage reply with no button; verify in `test/commands.test.ts`: `/drill` unchanged, `/drill 4` URL ends with `?unit=4`, `/drill abc` and `/drill 0` have no keyboard
- [ ] 4.2 Update the `/drill` description in the command list (`src/i18n.ts`) to mention the optional unit; verify the `/help` test in `test/commands.test.ts` still passes

## 5. Mini App

- [ ] 5.1 Add a `screen-picker` section and its styles to `public/drill/index.html` / `style.css`: an "all units" row, unit rows with `learned/total`, disabled rows that can't be tapped; verify by opening `/drill/` with `npm run dev` and checking the layout at phone width
- [ ] 5.2 In `public/drill/app.js`: read `?unit=` from the URL; if absent, call `units` and show the picker; send `{ unit }` to `start`; show "tối đa N phút · M cụm" plus a "Unit N" heading; handle `no_learned_in_unit` with a "Chọn unit khác" action back to the picker; verify manually in Telegram (or `npm run dev` with test init data) that "Tất cả", a finished unit, a partial unit and `/drill 4` all start correctly and a unit drill ends when its cards run out

## 6. Integration

- [ ] 6.1 Run `npm run typecheck` and `npm test`; both pass
- [ ] 6.2 Update `README.md` (drill section) to describe the unit picker and `/drill N`; verify the documented command matches the bot's behaviour
- [ ] 6.3 Run `openspec validate add-unit-drill --strict`; it passes

## Workflow follow-up

- Apply migration 0003 to the production D1 database before deploying (`wrangler d1 migrations apply <db> --remote`), then `npm run deploy`.
- Run `npm run tg:commands` so the updated `/drill` description reaches Telegram.
- Archive the change with `/opsx:archive` once deployed and checked.
