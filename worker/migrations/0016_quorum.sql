ALTER TABLE nodes ADD COLUMN trust_report TEXT;

UPDATE nodes
SET trust_report = json_object(
  'version', trust_version,
  'core', json(coalesce(trust_keys, '[]')),
  'access', json(coalesce(trust_keys, '[]')),
  'passphrase', json('false')
)
WHERE trust_version IS NOT NULL;

ALTER TABLE nodes DROP COLUMN trust_version;
ALTER TABLE nodes DROP COLUMN trust_keys;

ALTER TABLE devices ADD COLUMN verifies INTEGER;

ALTER TABLE actions ADD COLUMN device_id TEXT;

CREATE TABLE passphrase (
  owner_user_id TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  set_at TEXT NOT NULL
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  change TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  approvals TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('open', 'applied', 'expired', 'cancelled', 'superseded')),
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX idx_proposals_owner_status ON proposals(owner_user_id, status, expires_at);
