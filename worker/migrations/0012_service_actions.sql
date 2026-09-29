CREATE TABLE services (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('systemd', 'docker')),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'stopped', 'failed', 'starting')),
  since TEXT,
  system INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (node_id, kind, name)
);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('rolling', 'parallel')),
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('systemd', 'docker')),
  name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('start', 'stop', 'restart')),
  status TEXT NOT NULL CHECK (status IN
    ('queued', 'sent', 'done', 'failed', 'expired', 'cancelled', 'skipped')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  deliverable_at TEXT,
  sent_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  output TEXT
);

CREATE INDEX idx_actions_status_node ON actions(status, node_id);
CREATE INDEX idx_actions_node_requested ON actions(node_id, requested_at);
CREATE INDEX idx_actions_batch ON actions(batch_id, position);

ALTER TABLE nodes ADD COLUMN inventory_hash TEXT;
ALTER TABLE nodes ADD COLUMN inventory_at TEXT;
ALTER TABLE nodes ADD COLUMN refresh_requested_at TEXT;
