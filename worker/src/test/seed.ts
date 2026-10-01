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

const epochOf = (value: string) =>
  Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value,
  );

function windowOf(sqlite: DatabaseSync, nodeId: string, at: string): string {
  const row = sqlite
    .prepare("SELECT interval_seconds FROM nodes WHERE id = ?")
    .get(nodeId) as { interval_seconds: number } | undefined;
  const size = Math.max(300, row?.interval_seconds ?? 60) * 1000;
  return new Date(Math.floor(epochOf(at) / size) * size).toISOString();
}

interface WindowValues {
  samples: number;
  cpu_percent: number | null;
  memory_used_bytes: number | null;
  memory_total_bytes: number | null;
  load_1: number | null;
  load_5: number | null;
  load_15: number | null;
  checks: string;
}

const average = (
  current: number | null,
  next: number | null,
  samples: number,
) =>
  current === null || next === null
    ? (next ?? current)
    : (current * samples + next) / (samples + 1);

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
  const start = windowOf(sqlite, nodeId, recordedAt);
  const sample = {
    cpu: values.cpu === undefined ? 10 : values.cpu,
    memUsed: values.memUsed === undefined ? 4 : values.memUsed,
    memTotal: values.memTotal === undefined ? 8 : values.memTotal,
    load1: values.load1 ?? 0.5,
    load5: values.load5 ?? 0.4,
    load15: values.load15 ?? 0.3,
  };
  const row = sqlite
    .prepare(
      "SELECT samples, cpu_percent, memory_used_bytes, memory_total_bytes, load_1, load_5, load_15, checks FROM node_windows WHERE node_id = ? AND window_start = ?",
    )
    .get(nodeId, start) as WindowValues | undefined;
  const samples = row?.samples ?? 0;
  const had = samples > 0 ? row : undefined;
  sqlite
    .prepare(
      `INSERT INTO node_windows
         (node_id, window_start, samples, cpu_percent, memory_used_bytes,
          memory_total_bytes, disk_used_bytes, disk_total_bytes, load_1,
          load_5, load_15, uptime_seconds, checks)
       VALUES (?, ?, ?, ?, ?, ?, 20, 100, ?, ?, ?, 1000, ?)
       ON CONFLICT (node_id, window_start) DO UPDATE SET
         samples = excluded.samples, cpu_percent = excluded.cpu_percent,
         memory_used_bytes = excluded.memory_used_bytes,
         memory_total_bytes = excluded.memory_total_bytes,
         disk_used_bytes = excluded.disk_used_bytes,
         disk_total_bytes = excluded.disk_total_bytes,
         load_1 = excluded.load_1, load_5 = excluded.load_5,
         load_15 = excluded.load_15, uptime_seconds = excluded.uptime_seconds`,
    )
    .run(
      nodeId,
      start,
      samples + 1,
      had ? average(had.cpu_percent, sample.cpu, samples) : sample.cpu,
      had
        ? average(had.memory_used_bytes, sample.memUsed, samples)
        : sample.memUsed,
      had && had.memory_total_bytes !== null && sample.memTotal !== null
        ? Math.max(had.memory_total_bytes, sample.memTotal)
        : sample.memTotal,
      had ? average(had.load_1, sample.load1, samples) : sample.load1,
      had ? average(had.load_5, sample.load5, samples) : sample.load5,
      had ? average(had.load_15, sample.load15, samples) : sample.load15,
      row?.checks ?? "{}",
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
  const check = sqlite
    .prepare("SELECT node_id FROM checks WHERE id = ?")
    .get(checkId) as { node_id: string };
  const start = windowOf(sqlite, check.node_id, checkedAt);
  const row = sqlite
    .prepare(
      "SELECT checks FROM node_windows WHERE node_id = ? AND window_start = ?",
    )
    .get(check.node_id, start) as { checks: string } | undefined;
  const checks = JSON.parse(row?.checks ?? "{}") as Record<string, unknown[]>;
  const stored = checks[checkId];
  if (!stored || (stored[0] === "UP" && status === "DOWN")) {
    checks[checkId] =
      status === "DOWN" ? ["DOWN", latencyMs, "timeout"] : ["UP", latencyMs];
  }
  sqlite
    .prepare(
      `INSERT INTO node_windows (node_id, window_start, samples, checks)
       VALUES (?, ?, 0, ?)
       ON CONFLICT (node_id, window_start) DO UPDATE SET checks = excluded.checks`,
    )
    .run(check.node_id, start, JSON.stringify(checks));
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
