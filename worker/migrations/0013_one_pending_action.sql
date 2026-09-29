CREATE UNIQUE INDEX idx_actions_one_pending
  ON actions(node_id, kind, name) WHERE status IN ('queued', 'sent');
