import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { CHECK_LIMIT } from "../agent/ingest";
import { readAgentRelease } from "../agent/releases";
import { agentHttpOn, setAgentHttp } from "../agent/legacy";
import { fleetLive, mergeLive, pokeSoon } from "../fleet/client";
import { validateCheckTarget } from "../lib/checks";
import {
  agentOrigin,
  findOwnedNode,
  invalidRequest,
  readJson,
  type CheckRow,
  type KrynodesApp,
  type KrynodesContext,
  type KrynodesEnv,
} from "./shared";

export function registerAdminRoutes(
  app: KrynodesApp,
  requireAdmin: MiddlewareHandler<KrynodesEnv>,
): void {
  app.get("/api/overview", requireAdmin, async (context) => {
    const ownerId = context.get("identity").id;
    const [nodes, checks, incidents] = await Promise.all([
      context.env.DB.prepare(
        `SELECT id, name, hostname, architecture, operating_system, agent_version,
              last_seen_at, enrolled_at, disabled_at, interval_seconds,
              cpu_percent, memory_used_bytes, memory_total_bytes,
              disk_used_bytes, disk_total_bytes, load_1, uptime_seconds,
              created_at, update_requested_version, update_requested_at,
              update_attempts, update_error, auto_update, transport
       FROM nodes WHERE owner_user_id = ? ORDER BY created_at DESC`,
      )
        .bind(ownerId)
        .all(),
      context.env.DB.prepare(
        `SELECT c.id, c.node_id, c.name, c.kind, c.target, c.enabled,
              c.status, c.timeout_seconds, c.latency_ms, c.last_checked_at,
              c.consecutive_failures, c.last_message, c.public, c.public_note,
              c.created_at
       FROM checks c
       JOIN nodes n ON n.id = c.node_id
       WHERE n.owner_user_id = ?
       ORDER BY c.created_at DESC`,
      )
        .bind(ownerId)
        .all(),
      context.env.DB.prepare(
        `SELECT i.id, i.check_id, i.status, i.started_at, i.resolved_at,
              i.summary, c.name AS check_name, n.name AS node_name,
              c.node_id AS node_id
       FROM incidents i
       JOIN checks c ON c.id = i.check_id
       JOIN nodes n ON n.id = c.node_id
       WHERE n.owner_user_id = ?
       ORDER BY i.started_at DESC LIMIT 50`,
      )
        .bind(ownerId)
        .all(),
    ]);

    const rows = nodes.results as {
      id: string;
      transport: string;
      interval_seconds: number;
    }[];
    const live = rows.some((row) => row.transport === "stream")
      ? await fleetLive(context.env, ownerId)
      : {};
    return context.json({
      agentHttp: await agentHttpOn(context.env.DB),
      nodes: mergeLive(rows, live),
      checks: checks.results,
      incidents: incidents.results,
      agentRelease: {
        ...(await readAgentRelease(context.env.DB)),
        updateCommand: `curl -fsSL ${agentOrigin(context.env)}/install.sh | sudo sh -s -- --update`,
      },
    });
  });

  app.put("/api/agent-http", requireAdmin, async (context) => {
    const body = z
      .strictObject({ enabled: z.boolean() })
      .safeParse(await readJson(context));
    if (!body.success) return invalidRequest(context);
    await setAgentHttp(context.env.DB, body.data.enabled);
    return context.json({ agentHttp: body.data.enabled });
  });

  app.patch("/api/nodes/:id", requireAdmin, async (context) => {
    const node = await ownedNode(context);
    if (!node) return context.json({ code: "NOT_FOUND" }, 404);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        autoUpdate: z.boolean().optional(),
      })
      .refine((change) => Object.keys(change).length > 0)
      .safeParse(await readJson(context));
    if (!body.success) return invalidRequest(context);

    const { name, autoUpdate } = body.data;
    await context.env.DB.prepare(
      `UPDATE nodes
     SET name = COALESCE(?, name),
         auto_update = COALESCE(?, auto_update),
         updated_at = datetime('now')
     WHERE id = ?`,
    )
      .bind(
        name ?? null,
        autoUpdate === undefined ? null : Number(autoUpdate),
        context.req.param("id"),
      )
      .run();
    return context.json({ ok: true, ...body.data });
  });

  app.delete("/api/nodes/:id", requireAdmin, async (context) => {
    const node = await ownedNode(context);
    if (!node) return context.json({ code: "NOT_FOUND" }, 404);
    await context.env.DB.prepare("DELETE FROM nodes WHERE id = ?")
      .bind(context.req.param("id"))
      .run();
    return context.body(null, 204);
  });

  app.post("/api/checks", requireAdmin, async (context) => {
    const body = z
      .object({
        nodeId: z.string().uuid(),
        name: z.string().trim().min(1).max(100),
        kind: z.enum(["HTTP", "TCP", "SERVICE"]),
        target: z.string().trim().min(1).max(2048),
        timeoutSeconds: z.number().int().min(1).max(30).default(10),
      })
      .safeParse(await readJson(context));
    if (!body.success) return invalidRequest(context);

    const node = await findOwnedNode(
      context.env.DB,
      body.data.nodeId,
      context.get("identity").id,
    );
    if (!node) return context.json({ code: "NOT_FOUND" }, 404);

    const existing = await context.env.DB.prepare(
      "SELECT COUNT(*) AS total FROM checks WHERE node_id = ?",
    )
      .bind(body.data.nodeId)
      .first<{ total: number }>();
    if ((existing?.total ?? 0) >= CHECK_LIMIT) {
      return context.json(
        {
          code: "CHECK_LIMIT",
          message: `A node can run at most ${CHECK_LIMIT} checks.`,
        },
        400,
      );
    }

    const target = validateCheckTarget(body.data.kind, body.data.target);
    if (!target) {
      return context.json(
        { code: "INVALID_TARGET", message: "The check target is invalid." },
        400,
      );
    }

    const id = crypto.randomUUID();
    await context.env.DB.prepare(
      `INSERT INTO checks
     (id, node_id, name, kind, target, timeout_seconds)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        body.data.nodeId,
        body.data.name,
        body.data.kind,
        target,
        body.data.timeoutSeconds,
      )
      .run();
    pokeSoon(context, context.get("identity").id, [body.data.nodeId]);
    return context.json({ id }, 201);
  });

  app.patch("/api/checks/:id", requireAdmin, async (context) => {
    const check = await ownedCheck(context);
    if (!check) return context.json({ code: "NOT_FOUND" }, 404);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        name: z.string().trim().min(1).max(100).optional(),
        nodeId: z.string().uuid().optional(),
        kind: z.enum(["HTTP", "TCP", "SERVICE"]).optional(),
        target: z.string().trim().min(1).max(2048).optional(),
        timeoutSeconds: z.number().int().min(1).max(30).optional(),
        public: z.boolean().optional(),
        publicNote: z.string().trim().max(200).optional(),
      })
      .safeParse(await readJson(context));
    if (!body.success) return invalidRequest(context);
    const change = body.data;

    const kind = change.kind ?? check.kind;
    const target =
      change.kind !== undefined || change.target !== undefined
        ? validateCheckTarget(kind, change.target ?? check.target)
        : check.target;
    if (!target) {
      return context.json(
        { code: "INVALID_TARGET", message: "The check target is invalid." },
        400,
      );
    }
    const nodeId = change.nodeId ?? check.node_id ?? "";
    if (nodeId !== check.node_id) {
      const node = await findOwnedNode(
        context.env.DB,
        nodeId,
        context.get("identity").id,
      );
      if (!node) return context.json({ code: "NOT_FOUND" }, 404);
      const existing = await context.env.DB.prepare(
        "SELECT COUNT(*) AS total FROM checks WHERE node_id = ?",
      )
        .bind(nodeId)
        .first<{ total: number }>();
      if ((existing?.total ?? 0) >= CHECK_LIMIT) {
        return context.json(
          {
            code: "CHECK_LIMIT",
            message: `A node can run at most ${CHECK_LIMIT} checks.`,
          },
          400,
        );
      }
    }
    const pausing = change.enabled === false && check.enabled === 1;
    const fresh =
      pausing ||
      kind !== check.kind ||
      target !== check.target ||
      nodeId !== check.node_id;

    const updates: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      updates.push(`${column} = ?`);
      values.push(value);
    };
    if (change.enabled !== undefined) set("enabled", change.enabled ? 1 : 0);
    if (change.name !== undefined) set("name", change.name);
    if (change.timeoutSeconds !== undefined) {
      set("timeout_seconds", change.timeoutSeconds);
    }
    if (change.public !== undefined) set("public", change.public ? 1 : 0);
    if (change.publicNote !== undefined) {
      set("public_note", change.publicNote || null);
    }
    if (fresh) {
      set("node_id", nodeId);
      set("kind", kind);
      set("target", target);
      updates.push(
        "status = 'UNKNOWN'",
        "consecutive_failures = 0",
        "latency_ms = NULL",
        "last_message = NULL",
        "last_checked_at = NULL",
      );
    }
    if (updates.length === 0) return context.json({ ok: true });
    updates.push("updated_at = datetime('now')");
    const statements = [
      context.env.DB.prepare(
        `UPDATE checks SET ${updates.join(", ")} WHERE id = ?`,
      ).bind(...values, check.id),
    ];
    if (fresh) {
      statements.push(
        context.env.DB.prepare(
          `UPDATE incidents SET status = 'RESOLVED', resolved_at = ?
           WHERE check_id = ? AND status = 'OPEN'`,
        ).bind(new Date().toISOString(), check.id),
      );
    }
    await context.env.DB.batch(statements);
    pokeSoon(context, context.get("identity").id, [
      ...new Set([check.node_id ?? nodeId, nodeId]),
    ]);
    return context.json({ ok: true, fresh });
  });

  app.delete("/api/checks/:id", requireAdmin, async (context) => {
    const check = await ownedCheck(context);
    if (!check) return context.json({ code: "NOT_FOUND" }, 404);
    await context.env.DB.prepare("DELETE FROM checks WHERE id = ?")
      .bind(check.id)
      .run();
    if (check.node_id) {
      pokeSoon(context, context.get("identity").id, [check.node_id]);
    }
    return context.body(null, 204);
  });
}

async function ownedNode(context: KrynodesContext) {
  return findOwnedNode(
    context.env.DB,
    context.req.param("id") ?? "",
    context.get("identity").id,
  );
}

async function ownedCheck(context: KrynodesContext): Promise<CheckRow | null> {
  return context.env.DB.prepare(
    `SELECT c.id, c.node_id, c.name, c.kind, c.target, c.enabled,
            c.status, c.timeout_seconds, c.latency_ms, c.last_checked_at,
            c.consecutive_failures, c.last_message
     FROM checks c JOIN nodes n ON n.id = c.node_id
     WHERE c.id = ? AND n.owner_user_id = ? LIMIT 1`,
  )
    .bind(context.req.param("id"), context.get("identity").id)
    .first<CheckRow>();
}
