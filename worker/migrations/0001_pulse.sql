CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  agent_token_hash TEXT NOT NULL UNIQUE,
  architecture TEXT,
  operating_system TEXT,
  agent_version TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('HTTP', 'TCP', 'SERVICE')),
  target TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED')),
  started_at TEXT NOT NULL,
  resolved_at TEXT,
  summary TEXT
);

CREATE TABLE node_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  cpu_percent REAL,
  memory_used_bytes INTEGER,
  memory_total_bytes INTEGER,
  disk_used_bytes INTEGER,
  disk_total_bytes INTEGER,
  load_1 REAL,
  load_5 REAL,
  load_15 REAL,
  uptime_seconds INTEGER,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_nodes_owner_user_id ON nodes(owner_user_id);
CREATE INDEX idx_nodes_last_seen_at ON nodes(last_seen_at);
CREATE INDEX idx_checks_node_id ON checks(node_id);
CREATE INDEX idx_incidents_check_id_status ON incidents(check_id, status);
CREATE INDEX idx_node_metrics_node_id_recorded_at
  ON node_metrics(node_id, recorded_at);
