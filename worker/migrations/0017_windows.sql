CREATE TABLE node_windows (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 1,
  cpu_percent REAL,
  memory_used_bytes INTEGER,
  memory_total_bytes INTEGER,
  disk_used_bytes INTEGER,
  disk_total_bytes INTEGER,
  load_1 REAL,
  load_5 REAL,
  load_15 REAL,
  uptime_seconds INTEGER,
  checks TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (node_id, window_start)
) WITHOUT ROWID;

INSERT INTO node_windows (
  node_id, window_start, samples, cpu_percent, memory_used_bytes,
  memory_total_bytes, disk_used_bytes, disk_total_bytes, load_1, load_5,
  load_15, uptime_seconds
)
SELECT node_id,
       strftime('%Y-%m-%dT%H:%M:%fZ',
         (CAST(strftime('%s', recorded_at) AS INTEGER) / 300) * 300,
         'unixepoch') AS window_start,
       COUNT(*),
       AVG(cpu_percent),
       CAST(AVG(memory_used_bytes) AS INTEGER),
       MAX(memory_total_bytes),
       CAST(AVG(disk_used_bytes) AS INTEGER),
       MAX(disk_total_bytes),
       AVG(load_1),
       AVG(load_5),
       AVG(load_15),
       MAX(uptime_seconds)
FROM node_metrics
GROUP BY node_id, window_start;

INSERT INTO node_windows (node_id, window_start, samples, checks)
SELECT node_id, window_start, 0, json_group_object(check_id, json(result))
FROM (
  SELECT c.node_id AS node_id,
         strftime('%Y-%m-%dT%H:%M:%fZ',
           (CAST(strftime('%s', r.checked_at) AS INTEGER) / 300) * 300,
           'unixepoch') AS window_start,
         r.check_id AS check_id,
         CASE WHEN MIN(r.status) = 'DOWN'
           THEN json_array('DOWN',
             MAX(CASE WHEN r.status = 'DOWN' THEN r.latency_ms END),
             MAX(CASE WHEN r.status = 'DOWN' THEN r.message END))
           ELSE json_array('UP', MIN(r.latency_ms))
         END AS result
  FROM check_results r
  JOIN checks c ON c.id = r.check_id
  GROUP BY c.node_id, window_start, r.check_id
)
WHERE true
GROUP BY node_id, window_start
ON CONFLICT (node_id, window_start) DO UPDATE SET checks = excluded.checks;

DROP TABLE check_results;
DROP TABLE node_metrics;

ALTER TABLE nodes ADD COLUMN transport TEXT NOT NULL DEFAULT 'http';
