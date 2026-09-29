import { isProtectedTarget, isValidTarget } from "@krynodes/protocol";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { requestRefresh } from "../actions/inventory";
import {
  cancelStatement,
  createBatch,
  sweepStatements,
  type ActionRow,
} from "../actions/store";
import {
  invalidRequest,
  readJson,
  type KrynodesApp,
  type KrynodesEnv,
} from "./shared";

const RECENT_MS = 24 * 3_600_000;

const actionRequestSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
  mode: z.enum(["rolling", "parallel"]).default("rolling"),
  targets: z
    .array(
      z.object({
        nodeId: z.string().uuid(),
        kind: z.enum(["systemd", "docker"]),
        name: z.string().min(1).max(128),
      }),
    )
    .min(1)
    .max(50),
});

const refreshSchema = z.object({
  nodeIds: z.array(z.string().uuid()).max(100).optional(),
});

function toActionRecord(row: ActionRow) {
  return {
    id: row.id,
    batchId: row.batch_id,
    position: row.position,
    mode: row.mode,
    nodeId: row.node_id,
    kind: row.kind,
    name: row.name,
    action: row.action,
    status: row.status,
    requestedAt: row.requested_at,
    deliverableAt: row.deliverable_at,
    sentAt: row.sent_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    output: row.output,
  };
}

const targetKey = (target: { nodeId: string; kind: string; name: string }) =>
  `${target.nodeId}|${target.kind}|${target.name}`;

export function registerServiceRoutes(
  app: KrynodesApp,
  requireOperator: MiddlewareHandler<KrynodesEnv>,
): void {
  app.get("/api/services", requireOperator, async (context) => {
    const db = context.env.DB;
    const owner = context.get("identity").id;
    const now = Date.now();
    await db.batch(sweepStatements(db, now));
    const [nodes, services, actions] = await Promise.all([
      db
        .prepare(
          `SELECT id, inventory_at, refresh_requested_at FROM nodes
           WHERE owner_user_id = ? AND enrolled_at IS NOT NULL`,
        )
        .bind(owner)
        .all<{
          id: string;
          inventory_at: string | null;
          refresh_requested_at: string | null;
        }>(),
      db
        .prepare(
          `SELECT node_id, kind, name, state, since, system FROM services
           WHERE node_id IN (SELECT id FROM nodes WHERE owner_user_id = ?)
           ORDER BY node_id, kind, name`,
        )
        .bind(owner)
        .all<{
          node_id: string;
          kind: "systemd" | "docker";
          name: string;
          state: string;
          since: string | null;
          system: number;
        }>(),
      db
        .prepare(
          `SELECT * FROM actions
           WHERE node_id IN (SELECT id FROM nodes WHERE owner_user_id = ?)
             AND requested_at >= ?
           ORDER BY requested_at, position`,
        )
        .bind(owner, new Date(now - RECENT_MS).toISOString())
        .all<ActionRow>(),
    ]);
    return context.json({
      nodes: nodes.results.map((node) => ({
        id: node.id,
        inventoryAt: node.inventory_at,
        refreshRequestedAt: node.refresh_requested_at,
        services: services.results
          .filter((service) => service.node_id === node.id)
          .map((service) => ({
            kind: service.kind,
            name: service.name,
            state: service.state,
            since: service.since,
            system: service.system === 1,
          })),
      })),
      actions: actions.results.map(toActionRecord),
    });
  });

  app.get("/api/nodes/:id/actions", requireOperator, async (context) => {
    const db = context.env.DB;
    const node = await db
      .prepare("SELECT id FROM nodes WHERE id = ? AND owner_user_id = ?")
      .bind(context.req.param("id"), context.get("identity").id)
      .first<{ id: string }>();
    if (!node) return context.json({ code: "NOT_FOUND" }, 404);
    await db.batch(sweepStatements(db, Date.now()));
    const rows = await db
      .prepare(
        `SELECT * FROM actions WHERE node_id = ?
         ORDER BY requested_at DESC, position DESC LIMIT 10`,
      )
      .bind(node.id)
      .all<ActionRow>();
    return context.json({ actions: rows.results.map(toActionRecord) });
  });

  app.post("/api/actions", requireOperator, async (context) => {
    const parsed = actionRequestSchema.safeParse(await readJson(context));
    if (!parsed.success) return invalidRequest(context);
    const { action, mode, targets } = parsed.data;
    if (
      new Set(targets.map(targetKey)).size !== targets.length ||
      targets.some((target) => !isValidTarget(target.kind, target.name))
    ) {
      return invalidRequest(context);
    }
    if (targets.some((target) => isProtectedTarget(target.kind, target.name))) {
      return context.json(
        {
          code: "PROTECTED_TARGET",
          message: "Krynodes never controls this service.",
        },
        422,
      );
    }

    const db = context.env.DB;
    const identity = context.get("identity");
    const now = Date.now();
    const wanted = new Set(targets.map((target) => target.nodeId));
    const nodeIds = JSON.stringify([...wanted]);
    const nodes = await db
      .prepare(
        `SELECT id FROM nodes
         WHERE owner_user_id = ? AND enrolled_at IS NOT NULL AND disabled_at IS NULL
           AND id IN (SELECT value FROM json_each(?))`,
      )
      .bind(identity.id, nodeIds)
      .all<{ id: string }>();
    if (nodes.results.length !== wanted.size) {
      return context.json(
        { code: "NOT_FOUND", message: "A server was not found." },
        404,
      );
    }

    await db.batch(sweepStatements(db, now));
    const [known, pending] = await Promise.all([
      db
        .prepare(
          `SELECT node_id AS nodeId, kind, name FROM services
           WHERE node_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(nodeIds)
        .all<{ nodeId: string; kind: string; name: string }>(),
      db
        .prepare(
          `SELECT node_id AS nodeId, kind, name FROM actions
           WHERE status IN ('queued', 'sent')
             AND node_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(nodeIds)
        .all<{ nodeId: string; kind: string; name: string }>(),
    ]);
    const present = new Set(known.results.map(targetKey));
    if (targets.some((target) => !present.has(targetKey(target)))) {
      return context.json(
        {
          code: "UNKNOWN_TARGET",
          message: "A service is no longer on its server. Refresh the list.",
        },
        422,
      );
    }
    const busy = new Set(pending.results.map(targetKey));
    if (targets.some((target) => busy.has(targetKey(target)))) {
      return context.json(
        {
          code: "ACTION_PENDING",
          message: "An action for this service is still running.",
        },
        409,
      );
    }

    const batch = createBatch(db, {
      action,
      mode,
      targets,
      requestedBy: identity.email,
      now,
    });
    try {
      await db.batch(batch.statements);
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      return context.json(
        {
          code: "ACTION_PENDING",
          message: "An action for this service is still running.",
        },
        409,
      );
    }
    return context.json(
      { batchId: batch.batchId, actions: batch.actions },
      201,
    );
  });

  app.post("/api/actions/:batchId/cancel", requireOperator, async (context) => {
    const db = context.env.DB;
    const now = Date.now();
    const [cancelled] = await db.batch([
      cancelStatement(
        db,
        context.req.param("batchId"),
        context.get("identity").id,
        now,
      ),
      ...sweepStatements(db, now),
    ]);
    return context.json({ cancelled: cancelled?.meta.changes ?? 0 });
  });

  app.post("/api/services/refresh", requireOperator, async (context) => {
    const parsed = refreshSchema.safeParse((await readJson(context)) ?? {});
    if (!parsed.success) return invalidRequest(context);
    const refreshed = await requestRefresh(
      context.env.DB,
      context.get("identity").id,
      parsed.data.nodeIds,
      Date.now(),
    );
    return context.json({ refreshed }, 202);
  });
}
