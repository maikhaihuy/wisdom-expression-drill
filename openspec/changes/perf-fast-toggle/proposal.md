# Proposal

## Why

Tapping an item button (1, 2, 3, ...) to mark ✓/✗ feels slow: the loading spinner stays on the button for about a second. Each tap currently does 2–3 sequential D1 round trips plus Telegram API calls, all awaited in order, before the callback is answered.

## What Changes

- Item toggles no longer touch D1. The current mark of every item is read from the message's own inline keyboard (`callback_query.message.reply_markup`), toggled, and written back with `editMessageReplyMarkup`.
- The callback query is answered immediately (as the webhook HTTP response body), and the keyboard edit runs in `ctx.waitUntil`, so the spinner stops at once.
- "Chốt" and "Đúng hết" read all marks from the keyboard of the message they were tapped on and persist them to D1 in one batch, through the existing commit path.
- Measure latency before and after with `wrangler tail`. Enable Smart Placement only if Worker-side time is still significant.

Unchanged: the spoiler batch message, button labels and cycle (`·` → `✓` → `✗` → `·`), text grading, the commit summary and all spaced-repetition rules.

Out of scope:

- Moving or recreating the D1 database in another region.
- Any change to the message format or to how reveal works.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. Observable behavior stays as specified in `scheduled-review`; this is a performance change only (`skip_specs: true`).

## Impact

- `src/review.ts` (toggle and commit handlers), `src/telegram.ts` (webhook-reply helper), `src/index.ts` (webhook response for callbacks).
- Tests for toggle, commit and double commit are updated to the new data source.
- Optional: `[placement] mode = "smart"` in `wrangler.toml`.
