ALTER TABLE nodes ADD COLUMN enrollment_token_hash TEXT;
ALTER TABLE nodes ADD COLUMN enrollment_expires_at TEXT;
ALTER TABLE nodes ADD COLUMN enrolled_at TEXT;
ALTER TABLE nodes ADD COLUMN disabled_at TEXT;
ALTER TABLE nodes ADD COLUMN interval_seconds INTEGER NOT NULL DEFAULT 60;
ALTER TABLE nodes ADD COLUMN cpu_percent REAL;
ALTER TABLE nodes ADD COLUMN memory_used_bytes INTEGER;
ALTER TABLE nodes ADD COLUMN memory_total_bytes INTEGER;
ALTER TABLE nodes ADD COLUMN disk_used_bytes INTEGER;
ALTER TABLE nodes ADD COLUMN disk_total_bytes INTEGER;
ALTER TABLE nodes ADD COLUMN load_1 REAL;
ALTER TABLE nodes ADD COLUMN uptime_seconds INTEGER;

ALTER TABLE checks ADD COLUMN status TEXT NOT NULL DEFAULT 'UNKNOWN'
  CHECK (status IN ('UNKNOWN', 'UP', 'DOWN'));
ALTER TABLE checks ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 10;
ALTER TABLE checks ADD COLUMN latency_ms INTEGER;
ALTER TABLE checks ADD COLUMN last_checked_at TEXT;
ALTER TABLE checks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checks ADD COLUMN last_message TEXT;

CREATE TABLE check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('UP', 'DOWN')),
  latency_ms INTEGER,
  message TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_nodes_enrollment_token_hash
  ON nodes(enrollment_token_hash)
  WHERE enrollment_token_hash IS NOT NULL;
CREATE INDEX idx_check_results_check_id_checked_at
  ON check_results(check_id, checked_at);
CREATE INDEX idx_projects_owner_user_id_status
  ON projects(owner_user_id, status);
CREATE INDEX idx_notes_owner_user_id_pinned
  ON notes(owner_user_id, pinned);
