# Design

## Context

This change builds on `add-telegram-review`: users, `srs.applyResult` with `src = 'drill'`, and the 20:00 drill button already exist. `session_items` already has `latency_ms` and `first_try` (migration 0001). The motivation is in proposal.md.

## Goals / Non-Goals

**Goals:**

- No build step for the Mini App: plain HTML, CSS and JS served by Workers Static Assets.
- Smooth on mid-range phones. Card transitions must not wait on the network.

**Non-Goals:**

- A framework, bundler or service worker.
- Server-side timing enforcement. The drill is self-graded practice, not an exam.

## Decisions

### API

All endpoints take `X-Init-Data: <Telegram.WebApp.initData>`.

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /api/drill/start` | none | `{ sessionId, cardSeconds, totalSeconds, cards: [{ exprId, cue, en, example }] }` |
| `POST /api/drill/answers` | `{ sessionId, answers: [{ pos, exprId, result, latencyMs, firstTry }] }` | `{ ok: true, stored }` |
| `POST /api/drill/finish` | `{ sessionId }` | `{ cards, firstTryAccuracy, medianLatencyMs, missed: [{ en, cue }] }` |

`pos` is the display position in the session, which includes repeats. Inserts use `INSERT OR IGNORE` on `(session_id, pos)`. State updates run only for rows that were actually inserted with `first_try = 1`, so a resubmission changes nothing.

### Init data verification (src/initdata.ts)

1. Parse the query string, take out `hash`, sort the remaining `key=value` pairs, and join them with `\n`.
2. Compute `secret = HMAC_SHA256(key = "WebAppData", msg = BOT_TOKEN)`.
3. Require `hex(HMAC_SHA256(key = secret, msg = data_check_string)) === hash`, using a constant-time compare.
4. Require `now - auth_date <= 86400`, then parse `user` JSON and look up `users.id`.

Web Crypto only, no dependencies.

### Deck selection

This reuses `srs.missRate`. The SQL loads the user's learned active expressions (`card_state` join, `archived = 0`) with `LIMIT 500`. The 50/30/20 split and the backfill run in a pure function `selectDrillDeck(cards, size, now, rng)`, which is unit tested.

### Client (public/drill/)

- `Telegram.WebApp.ready()`, `expand()` and `disableVerticalSwipes()`. Colours come from `themeParams` (light and dark).
- The state machine runs: `cue → revealed → graded → next`. The deck queue lives in memory, and a missed card is spliced back in at `index + 3 + rand(0..2)`.
- Timers use `performance.now()`, and latency is measured from the cue paint to the reveal.
- Answers are buffered and flushed every 10 graded cards and at finish. A failed flush is retried with backoff while the app is open.
- `HapticFeedback.impactOccurred('light')` fires on grade, and swipe gestures use pointer events with a 60 px threshold.

### Alternative considered

A bot-only drill that sends one message per card was rejected. Telegram message latency and rate limits make 10-second cards unreliable, and the chat would fill with dozens of messages per day.

## Risks / Trade-offs

- [Init data replay within 24 hours] → acceptable, since replaying only gives access to the same user's own drill.
- [Users grading themselves generously] → by design, the drill only nudges hits on items not yet due (see `spaced-repetition`), so generous grading cannot fast-forward boxes.
- [iOS WebView quirks with swipe vs. scroll] → disable vertical swipes, and keep tap buttons as the primary input.

## Migration Plan

1. Add `assets = { directory = "public" }` and the drill vars, then deploy.
2. In BotFather, set the Menu Button to `https://<worker>/drill/`.

Rollback: remove the button and the assets. The API returns 404 and no data is affected.
