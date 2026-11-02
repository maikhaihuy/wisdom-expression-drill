# Proposal

## Why

The expression bank is authored in Obsidian and grows by a few dozen expressions every week. The Worker needs a single, safe way to receive that bank and reconcile it with D1 without ever losing users' review statistics.

## What Changes

- Scaffold the `expression-drill` Worker (wrangler config, D1 binding, router, test setup).
- Create the full D1 schema in `migrations/0001_init.sql` (bank tables and per-user tables), so later changes never need to rebuild primary keys.
- Add `POST /admin/sync`, authenticated with a bearer token, that accepts a version-3 payload in mode `all` or `week`.
- Reconcile the payload with the bank: insert new expressions, overwrite changed ones, skip unchanged ones, and archive expressions that disappeared from the synced scope.
- Run the whole reconciliation in one transaction and return counts.
- Notify the admin on Telegram when a sync adds or archives expressions.

Out of scope:

- Parsing Obsidian files and the GitHub Action (they live in the `english-vault` repo).
- Hard-deleting expressions. Archiving is the only removal.
- Member-authored expressions and multiple decks.

## Capabilities

### New Capabilities

- `bank-sync`: receiving the expression bank from the vault pipeline and reconciling it with the shared bank in D1.

### Modified Capabilities

None.

## Impact

- New: `wrangler.toml`, `migrations/0001_init.sql`, `src/index.ts`, `src/sync.ts`, `src/db.ts`, `test/sync.test.ts`.
- New secrets: `SYNC_TOKEN`, `TELEGRAM_BOT_TOKEN`, `ADMIN_CHAT_ID`.
- External contract: sync payload version 3, shared with the `english-vault` repo.
