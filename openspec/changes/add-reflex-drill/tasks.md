# Tasks

## 1. Server

- [ ] 1.1 Implement `verifyInitData` in `src/initdata.ts`, and verify tests with a real-format fixture signed by a test token for the valid, tampered-user, stale and unregistered cases
- [ ] 1.2 Implement `selectDrillDeck` as a pure function, and verify unit tests for the normal deck (60 distinct, none new), small history (12) and empty history
- [ ] 1.3 Implement `POST /api/drill/start`, and verify that an integration test creates a `drill` session for the init-data user while ignoring a spoofed `user_id` in the body
- [ ] 1.4 Implement `POST /api/drill/answers` with `INSERT OR IGNORE` and first-try-only state updates through `applyResult(..., 'drill')`, and verify that a resubmitted group changes nothing and an early hit only increments `hits`
- [ ] 1.5 Implement `POST /api/drill/finish` (close the session, set `last_drill_date`, compute the summary, send the chat message), and verify that a test with 48 cards and 40 first-try hits returns 83% and that the 20:00 batch omits the drill button

## 2. Mini App

- [ ] 2.1 Create `public/drill/` (HTML, CSS with Telegram theme variables, JS state machine) and add `assets` to wrangler.toml, and verify that `wrangler dev` serves `/drill/` and the page renders outside Telegram with a "please open in Telegram" notice
- [ ] 2.2 Implement the card flow (countdown, tap-to-reveal, timeout pre-selects "Sai", swipe and buttons, missed card reinserted 3–5 later), and verify a manual run in Telegram Desktop where a missed card reappears and the latency is recorded
- [ ] 2.3 Implement the buffered answer flush with retry and the finish screen, and verify that with network throttling in devtools no answers are lost and the summary matches the server response

## 3. Integration

- [ ] 3.1 Deploy, set the BotFather menu button, and run a full 5-minute drill on a phone, then verify the chat summary arrives and `/stats` reflects the drill hits and misses
- [ ] 3.2 Document the Mini App setup in README.md, and verify the documented BotFather steps match the current BotFather UI

## Workflow follow-up

- Archive with `openspec archive add-reflex-drill` after a week of daily drills.
