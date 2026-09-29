import type { MiddlewareHandler } from "hono";

import type { KrynodesApp, KrynodesEnv } from "./shared";

const SPAN_MS = 4 * 3_600_000;

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
}
