# Tasks

## 1. Telegram plumbing and access

- [x] 1.1 Expand `src/telegram.ts` (sendMessage, editMessageReplyMarkup, answerCallbackQuery; 403 → `UserBlockedError`) and verify with mocked-fetch tests that a 403 raises `UserBlockedError`
- [x] 1.2 Add `POST /tg/webhook` with secret-header check, private-chat filter and `ctx.waitUntil` dispatch, and verify tests for a wrong secret (401) and a group-chat update (ignored)
- [x] 1.3 Implement admin bootstrap, `/invite`, `/start <code>`, reactivation and the unregistered-user reply in `src/users.ts`, and verify one test per `user-access` scenario
- [x] 1.4 Add the ownership check for session-scoped callbacks and verify a test where user A's callback on user B's session is rejected

## 2. Spaced repetition (pure)

- [x] 2.1 Implement `applyResult`, `nextDue` (with quiet hours) and `missRate` in `src/srs.ts`, and verify unit tests for every `spaced-repetition` transition scenario with fixed timestamps in UTC+7
- [x] 2.2 Implement `selectBatch` (priority order, min/max, new limits, previous-batch exclusion with relaxation, injectable RNG for shuffling), and verify unit tests for the many-due, few-due, tiny-bank, daily-limit and small-bank-exclusion scenarios

## 3. Scheduled batches and grading

- [x] 3.1 Implement the candidate SQL queries and `createBatch` (closes the previous open batch as skip, creates the session and items, updates `new_today`), and verify an integration test against local D1
- [x] 3.2 Implement `renderBatch` (header, numbered cues, spoilers, HTML escaping, keyboard, 20:00 drill button), and verify snapshot tests including a cue containing `<` and `&`
- [x] 3.3 Implement the hourly `scheduled()` loop (local-hour filter, pause filter, sequential sends, per-user error isolation, deactivation on 403), and verify tests at 07:00 UTC and 16:00 UTC for a UTC+7 user and with one failing user
- [x] 3.4 Implement button toggling, "Đúng hết" and "Chốt" with the `closed_at IS NULL` guard, and verify tests for toggle-then-commit, all-correct, a tap on a closed batch and a double commit
- [x] 3.5 Implement `parseGradeText` and text commits, and verify table-driven tests for all four forms plus the invalid-length and no-open-batch cases
- [x] 3.6 Implement the commit summary, and verify that a test with 2 misses lists both misses with cue and first example

## 4. Commands

- [x] 4.1 Implement `/next`, `/drill`, `/pause`, `/resume` and `/tz` with argument validation, and verify one test per `bot-commands` scenario for these commands
- [x] 4.2 Implement `/stats` (box counts, 7-day accuracy, streak) and `/hard`, and verify against a fixture user with known history
- [x] 4.3 Implement `/members` (admin only) and the unknown-command help, and verify tests for admin, member and typo cases
- [ ] 4.4 Register the bot command menu via `setMyCommands` in a deploy script, and verify the Telegram client shows the list

## 5. Integration

- [ ] 5.1 Deploy, run `setWebhook`, bootstrap the admin and invite one test member, then verify end to end that `/next` → grade with buttons → summary works, and that the next scheduled hour delivers a batch
- [ ] 5.2 Update README.md with the webhook setup, cron behaviour and commands, and verify the documented `setWebhook` command works as written

## Workflow follow-up

- Archive with `openspec archive add-telegram-review` after three days of real use without defects.
