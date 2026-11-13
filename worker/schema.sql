-- USCW database schema (Cloudflare D1 / SQLite)
-- Apply with:  npx wrangler d1 execute uscw --remote --file=schema.sql
-- (use --local instead of --remote for local development)

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,          -- stored lowercase; this is the username
  pw_hash         TEXT NOT NULL,                 -- PBKDF2-SHA256, 100,000 iterations, hex
  pw_salt         TEXT NOT NULL,                 -- 16 random bytes, hex
  email_verified  INTEGER NOT NULL DEFAULT 0,
  is_admin        INTEGER NOT NULL DEFAULT 0,    -- 1 = CEO
  created_at      INTEGER NOT NULL
);

-- Failed-login tracking, keyed by email so unknown addresses lock out identically
CREATE TABLE IF NOT EXISTS login_attempts (
  email         TEXT PRIMARY KEY,
  failed        INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- Only a SHA-256 hash of the session token is stored
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- Email confirmation and password-reset tokens (hash only)
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, kind);

-- Every confirmation / reset email sent, used for the per-address (3/hour) and daily (250) limits
CREATE TABLE IF NOT EXISTS email_log (
  email    TEXT NOT NULL,
  sent_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_log_email ON email_log(email, sent_at);
CREATE INDEX IF NOT EXISTS idx_email_log_time ON email_log(sent_at);

-- One wrestler per player (id = user id). The CEO can also create NPC wrestlers (owner_id NULL).
CREATE TABLE IF NOT EXISTS wrestlers (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT,
  ring_name   TEXT NOT NULL,
  data        TEXT NOT NULL,                     -- JSON: bio, moves, finisher, etc.
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Shows such as Monday Night Mayhem and Premium Live Events, with the full card stored as JSON
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,                     -- YYYY-MM-DD
  published   INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL,                     -- JSON: time, venue, notes, segments
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);

-- Championships. The three titles are created once; the CEO awards them from the Champions page.
-- Safe to re-run: existing rows (and their holders) are left untouched.
CREATE TABLE IF NOT EXISTS championships (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('singles','tag')),
  holders     TEXT NOT NULL DEFAULT '[]',        -- JSON array of wrestler ids (empty = vacant)
  since       TEXT NOT NULL DEFAULT '',          -- YYYY-MM-DD the current champion(s) won it
  won_at      TEXT NOT NULL DEFAULT '',          -- where it was won, e.g. 'Rumble in the Jungle'
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO championships (id, name, kind, sort) VALUES
  ('world-heavyweight', 'World Heavyweight Championship',         'singles', 1),
  ('us-heavyweight',    'United States Heavyweight Championship', 'singles', 2),
  ('world-tag',         'World Tag Team Championship',            'tag',     3);

-- One row per viewer who presses "Start" on a show. The Worker creates this table by itself the first time it is
-- needed, so you do not have to run this; it is listed here for completeness. Rows are purged after 3 days.
CREATE TABLE IF NOT EXISTS show_views (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  speed       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_show_views_started ON show_views(started_at);
