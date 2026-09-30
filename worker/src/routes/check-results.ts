import type { MiddlewareHandler } from "hono";

import type { KrynodesApp, KrynodesEnv } from "./shared";

const SPAN_MS = 4 * 3_600_000;
const INCIDENT_PAD_MS = 10 * 60_000;

const epoch = (value: string) =>
  Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value,
  );

interface IncidentRow {
  id: string;
  check_id: string;
  status: "OPEN" | "RESOLVED";
  started_at: string;
  resolved_at: string | null;
  summary: string | null;
  check_name: string;
  check_kind: string;
  check_target: string;
  node_id: string;
  node_name: string;
}

export const CHECK_RESULTS_SQL = `
  SELECT r.check_id, r.status, r.latency_ms, r.message, r.checked_at
  FROM checks c
  JOIN nodes n ON n.id = c.node_id
  JOIN check_results r ON r.check_id = c.id AND r.checked_at >= ?2
  WHERE n.owner_user_id = ?1`;

interface ResultRow {
  check_id: string;
  status: "UP" | "DOWN";
  latency_ms: number | null;
  message: string | null;
  checked_at: string;
}

interface CheckHistory {
  results: {
    t: string;
    status: "UP" | "DOWN";
    latencyMs: number | null;
    message: string | null;
  }[];
  up4h: number | null;
}

export function registerCheckResultRoutes(
  app: KrynodesApp,
  requireAdmin: MiddlewareHandler<KrynodesEnv>,
): void {
  app.get("/api/checks/results", requireAdmin, async (context) => {
    const from = new Date(Date.now() - SPAN_MS).toISOString();
    const rows = await context.env.DB.prepare(CHECK_RESULTS_SQL)
      .bind(context.get("identity").id, from)
      .all<ResultRow>();

    const checks: Record<string, CheckHistory> = {};
    for (const row of rows.results) {
      (checks[row.check_id] ??= { results: [], up4h: null }).results.push({
        t: row.checked_at,
        status: row.status,
        latencyMs: row.latency_ms,
        message: row.message,
      });
    }
    for (const entry of Object.values(checks)) {
      entry.results.sort((a, b) => a.t.localeCompare(b.t));
      const up = entry.results.filter(
        (result) => result.status === "UP",
      ).length;
      entry.up4h =
        entry.results.length > 0 ? (up / entry.results.length) * 100 : null;
    }
    return context.json({ windowSeconds: 300, from, checks });
  });

  app.get("/api/incidents/:id", requireAdmin, async (context) => {
    const db = context.env.DB;
    const incident = await db
      .prepare(
        `SELECT i.id, i.check_id, i.status, i.started_at, i.resolved_at,
              i.summary, c.name AS check_name, c.kind AS check_kind,
              c.target AS check_target, c.node_id AS node_id,
              n.name AS node_name
       FROM incidents i
       JOIN checks c ON c.id = i.check_id
       JOIN nodes n ON n.id = c.node_id
       WHERE i.id = ? AND n.owner_user_id = ?`,
      )
      .bind(context.req.param("id"), context.get("identity").id)
      .first<IncidentRow>();
    if (!incident) return context.json({ code: "NOT_FOUND" }, 404);
    const start = epoch(incident.started_at) - INCIDENT_PAD_MS;
    const end =
      (incident.resolved_at ? epoch(incident.resolved_at) : Date.now()) +
      INCIDENT_PAD_MS;
    const rows = await db
      .prepare(
        `SELECT status, latency_ms, message, checked_at FROM check_results
         WHERE check_id = ? AND checked_at >= ? AND checked_at <= ?
         ORDER BY checked_at DESC LIMIT 100`,
      )
      .bind(
        incident.check_id,
        new Date(start).toISOString(),
        new Date(end).toISOString(),
      )
      .all<Omit<ResultRow, "check_id">>();
    return context.json({
      incident,
      results: rows.results.map((row) => ({
        t: row.checked_at,
        status: row.status,
        latencyMs: row.latency_ms,
        message: row.message,
      })),
    });
  });
}
