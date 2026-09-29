CREATE TABLE enrollment_tokens (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

DELETE FROM nodes WHERE enrolled_at IS NULL;
