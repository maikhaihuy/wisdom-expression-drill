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
