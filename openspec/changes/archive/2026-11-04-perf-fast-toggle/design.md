# Design

## Context

Today a tap on `t:<sid>:<pos>` does: load the session and its items from D1 → check ownership → update `session_items.result` → `editMessageReplyMarkup` → `answerCallbackQuery`, all awaited in order. Telegram's API servers are far from Asia (~150–300 ms each way) and D1 has a single primary region, so the spinner lasts roughly 0.7–1.5 s.

## Goals / Non-Goals

**Goals:**

- Zero D1 queries per toggle.
- The spinner stops as soon as the Worker receives the callback.

**Non-Goals:**

- Reducing Telegram's own network latency, which cannot be controlled.
- Changing commit semantics or the spaced-repetition rules.

## Decisions

### 1. The keyboard is the source of truth for open marks

The inline keyboard already encodes every item's mark in its label (`3 ·`, `3 ✓`, `3 ✗`), and Telegram sends the whole keyboard with every callback (`callback_query.message.reply_markup`).

- Toggle: parse the keyboard, cycle the tapped item's mark, and rebuild the keyboard. Each button's `callback_data` stays `t:<sid>:<pos>`.
- Parse marks from the label suffix (`·` / `✓` / `✗`). Keep this in a pure function `readMarks(keyboard): Map<pos, 'hit' | 'miss' | null>` with unit tests.
- No D1 read or write. Ownership is still safe: the message lives in the user's private chat, so only that user can tap it.

Alternative considered: keep writing marks to D1 but run the write in `waitUntil`. Rejected, because concurrent fast taps could race and leave D1 out of sync with the keyboard, and the keyboard is already authoritative for what the user sees.

### 2. Answer the callback in the webhook response

Telegram lets the webhook HTTP response carry one Bot API method call. For `callback_query` updates, return:

```json
{ "method": "answerCallbackQuery", "callback_query_id": "<id>" }
```

Run `editMessageReplyMarkup` in `ctx.waitUntil`. The spinner stops when the response reaches Telegram, without waiting for the edit.

### 3. Commit reads marks from the keyboard

On `a:<sid>` and `c:<sid>`:

1. Read the marks from `callback_query.message.reply_markup` using `readMarks`. For `a:`, unmarked items become `hit`.
2. Verify `sessions.user_id = from.id` and `closed_at IS NULL`, as today.
3. Write all `session_items.result` values, apply `applyResult` to `card_state`, and set `closed_at` in one `DB.batch` guarded by `closed_at IS NULL`. This is the existing commit path, but its input now comes from the keyboard.
4. Edit the message to remove the keyboard and send the summary. Answer the callback in the webhook response, as in decision 2.

Commit is still the only step that touches D1, so it keeps its current latency. That is acceptable because it happens once per batch.

### 4. Rapid taps

Each tap's edit is based on the keyboard in that tap's callback. Two very fast taps can both read the same old keyboard, so the second edit wins, and the visible keyboard always matches what will be committed. Because commit reads the keyboard it was tapped on, what the user sees is exactly what is saved.

### 5. Measure, then optionally use Smart Placement

Run `wrangler tail --format pretty` and record wall time for 10 toggles before and after this change. If the Worker-side time for commits is still above about 300 ms, add:

```toml
[placement]
mode = "smart"
```

and measure again.

## Risks / Trade-offs

- [Marks on a batch that is closed by a newer batch are lost] → they were never applied before commit anyway. The closed batch's items are recorded as `skip`, as the spec already says for unanswered items.
- [Telegram edits a keyboard and a newer tap reads stale labels] → the last edit wins and commit reads the keyboard it was tapped on, so what is saved always matches the screen.
- [`editMessageReplyMarkup` fails with "message is not modified"] → ignore that specific error.

## Migration Plan

Deploy normally. No schema change. Batches that are open during the deploy keep working, because their keyboards already carry the marks.
