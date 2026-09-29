CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE nodes ADD COLUMN update_requested_version TEXT;
ALTER TABLE nodes ADD COLUMN update_requested_at TEXT;
ALTER TABLE nodes ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 0;
