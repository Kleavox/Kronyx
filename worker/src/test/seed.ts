import type { DatabaseSync } from "node:sqlite";

export const OWNER = "standalone";

export function sqliteTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function seedNode(
  sqlite: DatabaseSync,
  node: {
    id: string;
    owner?: string;
    interval?: number;
    disabled?: boolean;
    enrolled?: boolean;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO nodes
         (id, owner_user_id, name, agent_token_hash, interval_seconds,
          enrolled_at, disabled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      node.id,
      node.owner ?? OWNER,
      node.id,
      `hash-${node.id}`,
      node.interval ?? 60,
      node.enrolled === false ? null : "2026-09-01 00:00:00",
      node.disabled ? "2026-09-02 00:00:00" : null,
    );
}

export function seedMetric(
  sqlite: DatabaseSync,
  nodeId: string,
  recordedAt: string,
  values: {
    cpu?: number | null;
    memUsed?: number | null;
    memTotal?: number | null;
    load1?: number;
    load5?: number;
    load15?: number;
  } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO node_metrics
         (node_id, cpu_percent, memory_used_bytes, memory_total_bytes,
          disk_used_bytes, disk_total_bytes, load_1, load_5, load_15,
          uptime_seconds, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nodeId,
      values.cpu === undefined ? 10 : values.cpu,
      values.memUsed === undefined ? 4 : values.memUsed,
      values.memTotal === undefined ? 8 : values.memTotal,
      20,
      100,
      values.load1 ?? 0.5,
      values.load5 ?? 0.4,
      values.load15 ?? 0.3,
      1000,
      recordedAt,
    );
}

export function seedCheck(
  sqlite: DatabaseSync,
  check: { id: string; nodeId: string; enabled?: boolean },
): void {
  sqlite
    .prepare(
      `INSERT INTO checks (id, node_id, name, kind, target, enabled)
       VALUES (?, ?, ?, 'HTTP', 'https://example.com/health', ?)`,
    )
    .run(check.id, check.nodeId, check.id, check.enabled === false ? 0 : 1);
}

export function seedResult(
  sqlite: DatabaseSync,
  checkId: string,
  checkedAt: string,
  status: "UP" | "DOWN",
  latencyMs: number | null = 50,
): void {
  sqlite
    .prepare(
      `INSERT INTO check_results (check_id, status, latency_ms, message, checked_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      checkId,
      status,
      latencyMs,
      status === "DOWN" ? "timeout" : null,
      checkedAt,
    );
}

export function seedIncident(
  sqlite: DatabaseSync,
  incident: {
    id: string;
    checkId: string;
    status: "OPEN" | "RESOLVED";
    startedAt: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO incidents (id, check_id, status, started_at, resolved_at, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      incident.id,
      incident.checkId,
      incident.status,
      incident.startedAt,
      incident.status === "RESOLVED" ? incident.startedAt : null,
      `${incident.checkId} changed state`,
    );
}
