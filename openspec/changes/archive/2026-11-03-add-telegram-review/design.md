# Design

## Context

`add-bank-sync` created the full schema and the shared bank. This change adds everything that talks to users over Telegram. The motivation is in proposal.md, and the behaviour is in the four delta specs.

## Goals / Non-Goals

**Goals:**

- Keep all scheduling and selection logic in pure functions, so every rule in `spaced-repetition` is unit-testable with fixed clocks.
- Acknowledge every webhook within Telegram's timeout. Heavy work runs in `ctx.waitUntil`.

**Non-Goals:**

- Queues or Durable Objects. Tens of users fit inside one cron invocation.
- Localisation beyond the Vietnamese UI strings kept in `src/i18n.ts`.

## Decisions

### Modules

```
src/
  index.ts       routes: POST /tg/webhook, POST /admin/sync; scheduled()
  telegram.ts    Bot API client: sendMessage, editMessageReplyMarkup, answerCallbackQuery; 403 → UserBlockedError
  users.ts       lookup, bootstrap admin, invites, registration, activation
  srs.ts         PURE: applyResult, nextDue, missRate, selectBatch
  review.ts      createBatch, renderBatch, toggleMark, commitBatch, parseGradeText
  commands.ts    /next /drill /stats /hard /pause /resume /tz /invite /members
  i18n.ts        Vietnamese UI strings
```

### Pure scheduling API (src/srs.ts)

```ts
type Result = 'hit' | 'miss' | 'skip';
type Source = 'batch' | 'drill';
interface CardState { box: number; due_at: number; hits: number; misses: number; lapses: number; last_seen_at: number | null }

const INTERVAL_SEC = [0, 4 * 3600, 86400, 3 * 86400, 7 * 86400, 16 * 86400, 35 * 86400]; // index = box

function applyResult(s: CardState | null, r: Result, now: number, src: Source, tzMin: number): CardState | null
function nextDue(now: number, box: number, tzMin: number): number        // applies quiet hours (22:00–08:00 local)
function missRate(s: CardState | null): number                           // (misses+1)/(hits+misses+2)
function selectBatch(input: {
  due: Candidate[]; fresh: Candidate[]; notDue: Candidate[];
  previousBatchIds: Set<string>; newAllowed: number; min: number; max: number; rng: () => number;
}): Candidate[]
```

`selectBatch` receives pre-loaded candidate lists. The SQL in `review.ts` loads them:

- **due**: active expressions joined with `card_state` for the user, where `due_at <= now`.
- **fresh**: active expressions with no `card_state` row for the user, `ORDER BY added_week DESC`.
- **notDue**: the user's learned active expressions with `due_at > now`, `LIMIT 50`.

`newAllowed = min(NEW_PER_BATCH, NEW_PER_DAY - new_today)`, after resetting `new_today` when `new_today_date` is not today.

### Cron

Use `crons = ["0 * * * *"]`. Each run loads the active, unpaused users, then for each user computes `localHour = floor(((now + tz*60) % 86400) / 3600)`. When `localHour` is even and between 8 and 22, it sends a batch. Sends are sequential with about 50 ms between them, well under Telegram's ~30 msg/s limit. Each user is wrapped in try/catch, and `UserBlockedError` sets `active = 0`.

Alternative considered: a cron at fixed UTC hours (`0 1-15/2 * * *`). Rejected because each user has their own timezone.

### Sessions and callback data

- Batch session id: `b-<userId>-<unix>`. Telegram limits `callback_data` to 64 bytes, so it carries a short form.
- `t:<sid>:<pos>` toggles an item, `a:<sid>` marks all correct, `c:<sid>` commits.
- Every callback checks that `sessions.user_id` equals `callback_query.from.id`, and rejects otherwise (`user-access` isolation).
- Marks are stored in `session_items.result` while the batch is open. Commit applies them through `applyResult` and sets `closed_at` in one `DB.batch`. The batch uses `UPDATE sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL` as a guard, so a double commit applies nothing.

### Message rendering

```
Ôn 14:00 · 7 cụm (2 mới)

1. bỏ qua lỗi nhỏ — đồng nghiệp mới làm sai, someone cuts in line
   <tg-spoiler>let it slide</tg-spoiler>
...
Nói to từng câu rồi bấm để chấm, hoặc gõ: 1o 2x 3o
```

- Keyboard: item buttons in rows of 5, labelled `3 ·`, `3 ✓` or `3 ✗`. The last row holds "Đúng hết" and "Chốt".
- The 20:00 drill button is a `web_app` button to `https://<worker>/drill/`.

### Text grading grammar

Input is normalised first: lowercase, trimmed, and `,` turned into a space.

- **All correct**: `^(ok|all o)$`.
- **Misses listed**: `^x(\s+\d+)+$`.
- **Positional**: `^[ox]+$`, and its length must equal the batch size.
- **Numbered**: every token matches `(\d+)-?([ox])` and every number is within 1..n.

Anything else is rejected with the help text.

## Risks / Trade-offs

- [The cron overruns its CPU time with many users] → it is sized for tens of users. If that grows, move the per-user sends to a Queue.
- [Telegram retries a webhook while the first attempt is still processing] → commits are guarded by `closed_at IS NULL`. The webhook returns 200 immediately, so retries are rare. A rare double toggle is visible on the keyboard, and the user can fix it with one more tap.
- [A user's clock or timezone is wrong, so batches arrive at night] → `/tz` lets them fix it, and `/pause` covers travel.
- [HTML injection through cues] → all user-visible bank text is escaped before rendering.

## Migration Plan

1. `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, add the cron and vars to wrangler.toml, then deploy.
2. Call `setWebhook` with `url=https://<worker>/tg/webhook`, `secret_token=<secret>`, and `allowed_updates=["message","callback_query"]`.
3. The admin sends `/start` (bootstrap), then `/invite` for each member.

Rollback: call `deleteWebhook` and remove the cron. No data migration is involved.
