# Proposal

## Why

Practising expressions needs a partner who keeps asking at the right moments. With the bank already in D1 (change `add-bank-sync`), the bot can play that partner: every two hours during the day it sends each user 5–10 expressions, chosen by spaced repetition so that forgotten ones come back sooner.

## What Changes

- Add the Telegram webhook (`POST /tg/webhook`), with secret-token verification.
- Add invite-only access: an admin bootstrapped from `ADMIN_CHAT_ID`, single-use invite codes, and registration with `/start <code>`.
- Add the Leitner scheduler: six boxes, promotion on a hit, demotion to box 1 on a miss, quiet hours, and per-user daily limits on new expressions.
- Add scheduled review batches: an hourly cron sends each user a batch at even local hours from 08:00 to 22:00. The message shows numbered cues with answers hidden in spoilers.
- Add grading by inline buttons and by text (`1o 2x`, `oxoox`, `ok`, `x 2 5`), followed by a summary.
- Add the commands `/next`, `/drill`, `/stats`, `/hard`, `/pause`, `/resume`, `/tz`, `/invite` and `/members`.

Out of scope:

- The Mini App reflex drill (change `add-reflex-drill`). This change only sends the button that opens it.
- Voice grading, answer variants, and multiple decks.
- Group chats. The bot works only in private chats.

## Capabilities

### New Capabilities

- `user-access`: who may use the bot (admin bootstrap, invites, registration, deactivation, per-user data isolation).
- `spaced-repetition`: per-user Leitner state transitions and selection of expressions for a batch.
- `scheduled-review`: delivering review batches on schedule and grading them by buttons or text.
- `bot-commands`: the user and admin slash commands other than registration.

### Modified Capabilities

None.

## Impact

- New: `src/telegram.ts` (expanded), `src/srs.ts`, `src/review.ts`, `src/commands.ts`, `src/users.ts`, plus tests for each.
- `wrangler.toml`: adds cron `0 * * * *` and vars `DEFAULT_TZ_OFFSET_MIN`, `BATCH_MIN`, `BATCH_MAX`, `NEW_PER_BATCH`, `NEW_PER_DAY`.
- New secret: `TELEGRAM_WEBHOOK_SECRET`.
- Uses the tables created in `migrations/0001_init.sql`. No schema change.
