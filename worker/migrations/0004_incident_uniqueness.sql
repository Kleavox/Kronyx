UPDATE incidents
SET status = 'RESOLVED',
    resolved_at = COALESCE(resolved_at, datetime('now'))
WHERE status = 'OPEN'
  AND id NOT IN (
    SELECT MIN(id)
    FROM incidents
    WHERE status = 'OPEN'
    GROUP BY check_id
  );

CREATE UNIQUE INDEX idx_incidents_one_open_per_check
  ON incidents(check_id)
  WHERE status = 'OPEN';
