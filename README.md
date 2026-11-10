# Expression Drill

A Telegram bot and Mini App for practising English expressions by active recall, running on Cloudflare Workers and D1.

The expression bank is authored in the `english-vault` repo. Its GitHub Action posts it to `POST /admin/sync`; that endpoint is the only writer of the shared bank.

## Development

```sh
npm install
npx wrangler d1 migrations apply expression-drill --local
npm run dev        # http://localhost:8787
npm test           # vitest in the Workers runtime, fresh D1 per test
npm run typecheck
```

For local secrets, create `.dev.vars` (git-ignored):

```
SYNC_TOKEN=dev-token
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
ADMIN_CHAT_ID=
```

The file name starts with a dot. Wrangler only reads `.dev.vars`, and only that name is git-ignored.

## Setup and deploy

1. Create the database and copy the printed `database_id` into `wrangler.toml`:

   ```sh
   npx wrangler d1 create expression-drill
   ```

2. Apply migrations to the remote database:

   ```sh
   npx wrangler d1 migrations apply expression-drill --remote
   ```

3. Set the secrets:

   ```sh
   npx wrangler secret put SYNC_TOKEN               # shared with the english-vault Action
   npx wrangler secret put TELEGRAM_BOT_TOKEN       # from @BotFather
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # random, 1-256 chars of A-Z a-z 0-9 _ -
   npx wrangler secret put ADMIN_CHAT_ID            # admin's Telegram user id
   ```

   Generate the webhook secret with, for example, `openssl rand -hex 32`.

4. Set `PUBLIC_URL` in `wrangler.toml` `[vars]` to the Worker's URL. The 20:00 batch uses it to open the drill Mini App.

5. Deploy:

   ```sh
   npx wrangler deploy
   ```

6. Check that the sync endpoint rejects unauthenticated requests. The response should be `401`:

   ```sh
   curl -i -X POST https://expression-drill.<subdomain>.workers.dev/admin/sync
   ```

7. Store the same `SYNC_TOKEN` and the Worker URL in the `english-vault` repo, then run its workflow manually in mode `all` for the initial import.

8. Connect the bot (see [Telegram bot](#telegram-bot)): set the webhook, register the command menu, then send `/start` to the bot from the admin account.

Rollback: redeploy the previous Worker version (`npx wrangler rollback`). The bank is rebuilt by the next full sync. To take the bot offline, call `deleteWebhook` and remove the cron from `wrangler.toml`.

## Telegram bot

### Webhook

Telegram delivers updates to `POST /tg/webhook`. The Worker rejects any request without the header `X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>` (HTTP 401). It ignores updates from groups and channels.

Set the webhook once after each change of URL or secret. Use the same values you stored with `wrangler secret put`:

```sh
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
WORKER_URL=https://expression-drill.<subdomain>.workers.dev npm run tg:webhook
```

This is equivalent to:

```sh
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://expression-drill.<subdomain>.workers.dev/tg/webhook","secret_token":"'"$TELEGRAM_WEBHOOK_SECRET"'","allowed_updates":["message","callback_query"]}'
```

Check the result with `TELEGRAM_BOT_TOKEN=... npm run tg:info`. It shows the webhook URL, any delivery errors and the registered commands.

### Command menu

Register the commands shown in Telegram's menu. Members get the user commands, and the admin's chat also gets `/invite` and `/members`:

```sh
TELEGRAM_BOT_TOKEN=... ADMIN_CHAT_ID=... npm run tg:commands
```

Run it again whenever the command list in `src/i18n.ts` changes. The scripts need Node 22.6 or later.

### Access

- **Admin:** the first `/start` from the user whose id equals `ADMIN_CHAT_ID` creates the admin. Once an admin exists, nobody else can become admin.
- **Members:** the admin sends `/invite` and forwards the reply. Each code is single-use and expires after 7 days. The new member sends `/start <code>`.
- **Blocked bot:** if a user blocks the bot, Telegram answers 403 and the user is deactivated. Sending `/start` again reactivates them, with their progress kept.

### Schedule

The cron runs every hour (`0 * * * *`). Each run sends one batch to every active, unpaused user whose local time is an even hour from 08:00 to 22:00. Local time comes from each user's `/tz`, which defaults to `DEFAULT_TZ_OFFSET_MIN` (UTC+7).

- A batch has 5–10 expressions. Due items come first, hardest first; then new items in course order, lowest unit and position first (at most 3 per batch and 20 per day); then items that aren't due yet, to reach 5. The previous batch's items are left out when possible.
- Sending a new batch closes the previous one: all of its items count as skipped, including marks that were never committed, and its buttons are removed.
- When the user has not drilled today, the 20:00 batch also has a button that opens the drill Mini App.
- Leitner boxes 1–6 set the next review: 4 h, 1 d, 3 d, 7 d, 16 d, 35 d. A miss sends an item back to box 1. Due times that would fall between 22:00 and 08:00 move to 08:00.

The batch sizes and new-item limits are the `BATCH_MIN`, `BATCH_MAX`, `NEW_PER_BATCH` and `NEW_PER_DAY` vars in `wrangler.toml`.

On the free plan, one cron run uses 2 D1 queries plus 1 per user who gets a batch, and 1 Telegram call per user, plus 1 more to remove the buttons when that user left the previous batch ungraded. Both are capped at 50 per run, so one hour can serve about 45 users who grade their batches, and about 25 who don't. Above that, move the sends to a Queue.

### Grading

Each batch message shows numbered cues, with the expression hidden in a spoiler. Say each expression out loud, then grade the batch in one of two ways:

- **Buttons:** tap a number to cycle it through `·` (unanswered), `✓` and `✗`. **Chốt** commits, and unmarked items count as skipped. **Đúng hết** marks every unmarked item correct and commits. Marks live only in the message's keyboard until you commit, so a tap needs no database call and answers at once; the commit saves exactly what the keyboard shows.
- **Text reply:** the reply grades the latest open batch.

| Text | Meaning |
|---|---|
| `1o 2x 4o` or `1-o, 2-x` | Grade by number. Unlisted items are skipped. |
| `oxoox` | One letter per item, in order. Must match the batch size. |
| `ok` or `all o` | All correct. |
| `x 2 5` | Items 2 and 5 wrong, the rest correct. |

The bot then replies with the score and, for each missed item, its expression, cue and first example. A batch is committed only once.

### Commands

| Command | Who | What it does |
|---|---|---|
| `/start <code>` | anyone | Register with an invite code, or reactivate |
| `/next` | members | Send a batch now, even while paused or at night |
| `/drill` or `/drill 4` | members | Button that opens the reflex drill: the unit picker, or unit 4 directly |
| `/stats` | members | Bank size, expressions seen, count per box, 7-day accuracy, streak |
| `/hard` | members | Up to 10 most-missed expressions (answered at least 3 times) |
| `/pause 3h` or `/pause 2d` | members | Stop scheduled batches, from 1 hour to 30 days |
| `/resume` | members | End the pause |
| `/tz +7` / `-5` / `+5:30` | members | Set your timezone (−12:00 to +14:00) |
| `/invite` | admin | Create an invite code |
| `/members` | admin | Every user, with active flag, last answer date and 7-day accuracy |

Any other command replies with the command list.

## Reflex drill (Mini App)

A timed, self-graded drill of at most 5 minutes that runs inside Telegram. It ends when the time is up or when no cards are left, whichever comes first. Each card shows only the cue with a countdown (`CARD_SECONDS`, 10 seconds). Tap to reveal the expression early; if the time runs out, it is revealed with **Sai** pre-selected. Grade each card with ✓ Đúng / ✗ Sai, by swiping right or left, or with → / ← on a desktop keyboard.

- **Scope:** the app opens on a picker. **Tất cả** drills all units. Below it, each course unit shows `learned/total` for the user: units with learned expressions come first, newest unit first, and units with nothing learned follow, marked **Chưa học · luyện thử**. `/drill N` opens the drill for unit N directly and skips the picker.
- **Deck (Tất cả):** up to 60 expressions the user has already learned (box 1 or higher). About half are the ones they miss most, 30% are due, and 20% are random from boxes 2–5. A user who has learned nothing yet is asked to practise with batches first.
- **Deck (unit):** the user's learned expressions (box 1 or higher) from that unit, in random order, up to 60. Unlearned expressions are never included. If a unit has unlearned expressions, its start screen also offers **Luyện thử cả unit**.
- **Luyện thử (practice):** every active expression of one unit, learned or not, in random order, up to 60. It works like the drill but **saves nothing**: no session, no answers, no review-state change, no new expressions introduced, nothing in `/stats` or `/hard`, no chat message, and it doesn't mark the day as drilled. The summary is shown only in the app, tagged **Luyện thử · không lưu**. Units with nothing learned open practice from the picker; `/drill N` for such a unit offers **Luyện thử unit N** or **Chọn unit khác**.
- **Missed cards** come back 3–5 cards later until answered correctly. Only the first attempt at each expression counts toward review state. An early correct answer on a card that isn't due yet only adds a hit; it never moves the card to a higher box.
- **Finishing** sends a summary to the chat: cards, first-try accuracy, median reaction time and the missed expressions. A unit drill's summary names the unit. Only a **Tất cả** drill marks the day as drilled, so the 20:00 batch leaves out the drill button; a unit drill doesn't.
- **Settings:** `DRILL_SECONDS`, `CARD_SECONDS` and `DRILL_DECK_SIZE` in `wrangler.toml` `[vars]`.

### Setup

The page lives in `public/drill/` and is served as static assets by the same Worker (`assets = { directory = "public" }`), so `npx wrangler deploy` publishes it. Check that `https://expression-drill.<subdomain>.workers.dev/drill/` loads; outside Telegram it shows a notice to open it from the bot.

Users can open the drill in three ways: the button that `/drill` (or `/drill N`) sends, the button on the 20:00 batch, and the bot's menu button. To set the menu button, which sits next to the message field:

1. Open @BotFather and send `/mybots`, then choose the bot.
2. Go to **Bot Settings → Menu Button → Configure menu button**.
3. Send the URL `https://expression-drill.<subdomain>.workers.dev/drill/`.
4. Send the button title, for example `Luyện phản xạ`.

To remove the button, choose **Remove menu button** in the same menu.

### API

The Mini App calls five endpoints. Each request carries `X-Init-Data: <Telegram.WebApp.initData>`. The Worker checks its signature against `TELEGRAM_BOT_TOKEN`, rejects data older than 24 hours, and takes the user only from it, never from the request body.

| Endpoint | Purpose |
|---|---|
| `POST /api/drill/units` | Returns `{ units: [{ unit, learned, total }] }` for the picker, in picker order. |
| `POST /api/drill/start` | Creates a drill session and returns the deck. Optional body `{ "unit": N }` scopes it to one unit and adds `unitTotal` (active expressions in the unit) to the response; no body or `null` drills all units. `401` if the user is not registered, `409` (`no_learned` / `no_learned_in_unit`) if they have learned nothing in scope, `422` for a unit that is not a positive integer. |
| `POST /api/drill/practice` | Body `{ "unit": N }`. Returns the practice deck for unit N. Read-only: it creates no session and writes nothing. `409 empty_unit` if the unit has no active expressions, `422 invalid_unit` for a missing or invalid unit. |
| `POST /api/drill/answers` | Stores up to 100 answers. A position that is already stored is ignored, so retries are safe. |
| `POST /api/drill/finish` | Closes the session and returns the summary, including `unit` (`null` for all units). Calling it again returns the same summary without a second chat message. |

The app sends answers every 10 cards and at the end, and retries failed requests while it stays open. If the app is closed early, the answers already sent are kept and the day is not marked as drilled.

### Testing locally

Outside Telegram the page has no init data. To try the full flow in a browser against `npm run dev`, sign init data with the bot token from `.dev.vars` and pass it in the URL hash, the same way Telegram does:

```
http://localhost:8787/drill/#tgWebAppData=<url-encoded init data>&tgWebAppVersion=8.0&tgWebAppPlatform=tdesktop
```

Open it in a fresh tab. A hash-only change does not reload Telegram's script. The local user must exist and have learned expressions.

## Sync endpoint

`POST /admin/sync` with `Authorization: Bearer <SYNC_TOKEN>` and a version-4 payload. The vault keeps one file per course unit (`unit-NN.md`), and each item carries its `unit` and its 1-based `position` in that file:

```json
{
  "version": 4,
  "mode": "unit",
  "unit": 3,
  "items": [
    {
      "id": "let-it-slide",
      "en": "let it slide",
      "cue": "bỏ qua lỗi nhỏ",
      "examples": ["Just let it slide this time, he's new."],
      "note": "informal",
      "tags": [],
      "unit": 3,
      "position": 1,
      "content_hash": "9f2c…"
    }
  ]
}
```

- `mode: "all"` syncs the whole bank, and `unit` is omitted or null. `mode: "unit"` syncs one unit, and every item's `unit` must equal it. `unit` and `position` are positive integers.
- An existing expression is overwritten when its `content_hash`, `unit` or `position` changes, so a move or reorder keeps every user's progress.
- Expressions in scope that are missing from the payload are archived, never deleted. A unit sync only archives within its unit.
- Any other `version` gets `422` with `unsupported payload version N, expected 4`.
- The whole sync is one transaction. Sending the same payload again changes nothing.
- Responses: `200` with `{ mode, unit, added, updated, unarchived, unchanged, archived, total_active }`, `401` for a bad token, `422` with `{ error }` for an invalid payload, `500` if the database write fails (nothing is persisted).
- When a sync adds or archives expressions, the admin receives a Telegram message. A failed message does not fail the sync.
