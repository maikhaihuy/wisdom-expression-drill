# Proposal

## Why

Scheduled batches build memory, but not speed. Users also need a short daily session where cues come one after another under time pressure, so the expression comes out as a reflex instead of after thinking.

## What Changes

- Add a Telegram Mini App at `/drill/`, served as static assets by the same Worker.
- A drill lasts 300 seconds. Each card shows a cue with a 5-second countdown and then reveals the answer. The user self-grades by swiping or tapping.
- Missed cards come back 3–5 cards later until answered correctly. Only the first attempt per card counts towards spaced repetition.
- Add the drill API (`/api/drill/start`, `/answers`, `/finish`), authenticated with Telegram Mini App init data.
- At the end, the Mini App shows a summary and the bot posts it to the user's chat. `last_drill_date` is updated, which suppresses the 20:00 reminder button.

Out of scope:

- Voice recording or automatic grading.
- Leaderboards or comparing users.
- Offline mode beyond retrying unsent answers while the app stays open.

## Capabilities

### New Capabilities

- `reflex-drill`: the timed self-graded drill session, its deck composition, its API and its effect on review state.

### Modified Capabilities

None. Drill results use the existing `spaced-repetition` rules, including the drill-specific rule for items not yet due that is already in that spec.

## Impact

- New: `public/drill/index.html`, `public/drill/app.js`, `public/drill/style.css`, `src/drill-api.ts`, `src/initdata.ts`, plus tests.
- `wrangler.toml`: `assets = { directory = "public" }`, plus vars `DRILL_SECONDS` (300), `CARD_SECONDS` (5) and `DRILL_DECK_SIZE` (60).
- BotFather: set the Menu Button URL to `https://<worker>/drill/`.
