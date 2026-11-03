# Tasks

## 1. Baseline

- [ ] 1.1 Run `wrangler tail --format pretty`, tap 10 item buttons and 1 "Chốt", and record the wall time per request in this change folder (`baseline.md`), and verify the file lists 11 timings

## 2. Keyboard as state

- [ ] 2.1 Implement the pure functions `readMarks(keyboard)` and `toggleKeyboard(keyboard, pos)` (cycle `·` → `✓` → `✗` → `·`, `callback_data` unchanged), and verify unit tests cover each transition, a 10-item keyboard and the commit rows staying intact
- [ ] 2.2 Rewrite the `t:` handler to use only the callback's keyboard (no D1 calls) and run `editMessageReplyMarkup` in `ctx.waitUntil`, ignoring "message is not modified", and verify with a test using a D1 spy that zero queries run per toggle

## 3. Fast callback answer

- [ ] 3.1 For `callback_query` updates, return `{"method":"answerCallbackQuery","callback_query_id":...}` as the webhook response body (with a notice text where the old code showed one, e.g. a closed batch), and verify with a test that the HTTP response body contains the method and that no separate `answerCallbackQuery` fetch is made

## 4. Commit from keyboard

- [ ] 4.1 Change "Chốt" and "Đúng hết" to read marks with `readMarks` from the tapped message and pass them to the existing commit batch (ownership and `closed_at IS NULL` guards unchanged), and verify the existing scenarios (toggle then commit, all correct, tap on a closed batch, double commit) still pass
- [ ] 4.2 Verify that a batch closed by a newer batch records all its items as `skip`, with a test that marks items, sends `/next`, and checks that `card_state` is unchanged

## 5. Measure

- [ ] 5.1 Deploy, repeat the baseline measurement, and append the results to `baseline.md`, and verify that the toggle wall time dropped and the spinner stops visibly faster on a phone
- [ ] 5.2 Only if commit Worker time is still above about 300 ms: add `[placement] mode = "smart"`, redeploy and measure again, and verify the numbers are recorded with the decision

## Workflow follow-up

- Archive with `openspec archive perf-fast-toggle --skip-specs` after a day of normal use.
