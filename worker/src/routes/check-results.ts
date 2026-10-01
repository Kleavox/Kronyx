import type { MiddlewareHandler } from "hono";

import { expandResults, windowSize, type WindowRow } from "../agent/windows";
import type { KrynodesApp, KrynodesEnv } from "./shared";

const SPAN_MS = 4 * 3_600_000;
const WINDOW_MS = 300_000;
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
  SELECT w.window_start, w.checks
  FROM nodes n
  JOIN node_windows w ON w.node_id = n.id AND w.window_start >= ?2
  WHERE n.owner_user_id = ?1`;

const OWNED_CHECKS_SQL = `
  SELECT c.id FROM checks c
  JOIN nodes n ON n.id = c.node_id
  WHERE n.owner_user_id = ?1`;

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
    const ownerId = context.get("identity").id;
    const from = new Date(
      (Math.floor((Date.now() - SPAN_MS) / WINDOW_MS) - 2) * WINDOW_MS,
    ).toISOString();
    const [rows, owned] = await Promise.all([
      context.env.DB.prepare(CHECK_RESULTS_SQL)
        .bind(ownerId, from)
        .all<WindowRow>(),
      context.env.DB.prepare(OWNED_CHECKS_SQL)
        .bind(ownerId)
        .all<{ id: string }>(),
    ]);
    const expanded = expandResults(
      rows.results,
      new Set(owned.results.map((row) => row.id)),
    );
    const checks: Record<string, CheckHistory> = {};
    for (const [checkId, results] of expanded) {
      const up = results.filter((result) => result.status === "UP").length;
      checks[checkId] = {
        results,
        up4h: results.length > 0 ? (up / results.length) * 100 : null,
      };
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
    const node = await db
      .prepare("SELECT interval_seconds FROM nodes WHERE id = ?")
      .bind(incident.node_id)
      .first<{ interval_seconds: number }>();
    const rows = await db
      .prepare(
        `SELECT window_start, checks FROM node_windows
         WHERE node_id = ? AND window_start >= ? AND window_start <= ?
         ORDER BY window_start DESC LIMIT 100`,
      )
      .bind(
        incident.node_id,
        new Date(
          start - windowSize(node?.interval_seconds ?? 60) + 1,
        ).toISOString(),
        new Date(end).toISOString(),
      )
      .all<WindowRow>();
    const results = (
      expandResults(rows.results, new Set([incident.check_id])).get(
        incident.check_id,
      ) ?? []
    ).reverse();
    return context.json({ incident, results });
  });
}
