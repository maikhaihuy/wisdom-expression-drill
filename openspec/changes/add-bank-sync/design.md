# Design

## Context

This is the first change in an empty repo. The bank is authored in the `english-vault` repo, where a GitHub Action parses every week file (`YYYY-Www.md`), validates the whole bank, filters by mode, and POSTs the payload below. All reasons are in proposal.md.

## Goals / Non-Goals

**Goals:**

- One schema migration that already fits the multi-user model, so no primary-key rebuild is ever needed.
- A sync that is idempotent: sending the same payload twice changes nothing the second time.

**Non-Goals:**

- Partial or diff-based payloads. The vault always sends every item in scope.
- Any per-user logic. Review tables are created here but only used by later changes.

## Decisions

### Project layout

```
wrangler.toml
migrations/0001_init.sql
src/
  index.ts      router: fetch() + scheduled() (scheduled is a no-op in this change)
  sync.ts       POST /admin/sync: validate, reconcile, report, notify
  db.ts         typed D1 helpers
  telegram.ts   minimal sendMessage (used for the admin notification)
test/
  sync.test.ts
```

### wrangler.toml (initial)

```toml
name = "expression-drill"
main = "src/index.ts"
compatibility_date = "2026-10-01"

[[d1_databases]]
binding = "DB"
database_name = "expression-drill"
database_id = "<from wrangler d1 create>"
migrations_dir = "migrations"

# secrets: SYNC_TOKEN, TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID
```

### Schema (migrations/0001_init.sql)

The full schema is created now. `expressions` is shared and written only by sync. Every other table is per user, directly or through `sessions`.

```sql
-- ===== Per user =====
CREATE TABLE users (
  id              INTEGER PRIMARY KEY,          -- Telegram user id
  name            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  tz_offset_min   INTEGER NOT NULL DEFAULT 420,
  active          INTEGER NOT NULL DEFAULT 1,
  paused_until    INTEGER,
  last_drill_date TEXT,                         -- 'YYYY-MM-DD' in the user's local time
  new_today       INTEGER NOT NULL DEFAULT 0,
  new_today_date  TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE invites (
  code       TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id),
  used_by    INTEGER REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- ===== Shared =====
CREATE TABLE expressions (
  id           TEXT PRIMARY KEY,                -- slug(en) or explicit ^id
  en           TEXT NOT NULL,
  cue          TEXT NOT NULL,
  examples     TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
  note         TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
  added_week   TEXT NOT NULL,                   -- '2026-W43'
  content_hash TEXT NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_expr_week ON expressions(added_week, archived);

-- ===== Review state per user =====
CREATE TABLE card_state (
  user_id      INTEGER NOT NULL REFERENCES users(id),
  expr_id      TEXT NOT NULL REFERENCES expressions(id),
  box          INTEGER NOT NULL DEFAULT 0,
  due_at       INTEGER NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 0,
  misses       INTEGER NOT NULL DEFAULT 0,
  lapses       INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  PRIMARY KEY (user_id, expr_id)
);
CREATE INDEX idx_card_user_due ON card_state(user_id, due_at);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('batch','drill')),
  message_id INTEGER,
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
);
CREATE INDEX idx_sessions_open ON sessions(user_id, kind, closed_at);

CREATE TABLE session_items (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  pos         INTEGER NOT NULL,
  expr_id     TEXT NOT NULL REFERENCES expressions(id),
  result      TEXT CHECK (result IN ('hit','miss','skip')),
  latency_ms  INTEGER,
  first_try   INTEGER NOT NULL DEFAULT 1,
  answered_at INTEGER,
  PRIMARY KEY (session_id, pos)
);
CREATE INDEX idx_items_expr ON session_items(expr_id, answered_at);
```

### Payload contract (version 3, shared with english-vault)

```json
{
  "version": 3,
  "mode": "week",
  "week": "2026-W43",
  "generated_at": "2026-10-24T07:00:00Z",
  "items": [
    {
      "id": "let-it-slide",
      "en": "let it slide",
      "cue": "bỏ qua lỗi nhỏ — đồng nghiệp mới làm sai, someone cuts in line",
      "examples": ["Just let it slide this time, he's new."],
      "note": "informal",
      "tags": [],
      "added_week": "2026-W43",
      "content_hash": "9f2c…"
    }
  ],
  "warnings": ["2026-W43.md:12 missing cue"]
}
```

`week` is omitted or null in `all` mode. `content_hash` is computed by the vault; the Worker treats it as opaque and never recomputes it.

### Reconciliation algorithm

1. Load `id, content_hash, added_week, archived` for the whole bank in one query. The bank is small (thousands of rows), and an item may currently belong to another week.
2. Classify each item into insert, update, unarchive (counted separately from update) or unchanged.
3. Compute the archive set: active ids in scope minus payload ids.
4. Build one `DB.batch([...])` with every INSERT and UPDATE plus a single `UPDATE expressions SET archived = 1, updated_at = ? WHERE id IN (...)`. D1 runs a batch as one transaction.
5. After the batch commits, send the admin notification in `ctx.waitUntil`.

Alternatives considered:

- *Delta payloads* (only changed items): smaller, but drift is never repaired and deletions need extra signalling. Rejected because the full bank is only a few hundred KB.
- *Archive by absence from the whole bank* in week mode: rejected, because syncing a single week would archive every other week.
- *Create `card_state` rows at sync time*: rejected. Rows are created lazily on a user's first graded answer, so adding users or expressions needs no backfill.

## Risks / Trade-offs

- [D1 batch statement limits on a very large first sync] → chunk statements into several batches only if a single batch is refused; still return HTTP 500 on any failure. Expected bank size makes this unlikely.
- [A wrong `SYNC_TOKEN` in the vault repo makes syncs silently stale] → the Action fails on any non-2xx, so the failure is visible in GitHub.
- [The vault sends a malformed but well-typed bank, e.g. a parser bug that drops half the items] → the vault validates first; the admin notification also shows unusual archive counts.

## Migration Plan

1. `wrangler d1 create expression-drill`, then put the id in wrangler.toml.
2. `wrangler d1 migrations apply expression-drill --remote`.
3. `wrangler secret put SYNC_TOKEN` (also `TELEGRAM_BOT_TOKEN`, `ADMIN_CHAT_ID`), then `wrangler deploy`.
4. Run the vault workflow manually (mode `all`) for the initial import.

Rollback: redeploy the previous Worker version. Bank data is regenerated by the next full sync.
