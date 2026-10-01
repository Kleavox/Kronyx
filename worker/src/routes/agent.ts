import { agentConfigResponseSchema } from "@krynodes/protocol";

import { applyInventory } from "../actions/inventory";
import {
  actionResultStatements,
  heartbeatActions,
  sweepStatements,
} from "../actions/store";
import {
  acceptResults,
  commit,
  heartbeatResponse,
  heartbeatStatements,
  loadAgentConfig,
  resultStatements,
  type AgentNode,
  windowStatements,
} from "../agent/ingest";
import { hubFor, streamsOn } from "../fleet/client";
import { randomToken, readBearerToken, sha256 } from "../lib/crypto";
import { actionsSchema, heartbeatSchema, hostSchema } from "../schemas";
import { readJson, type KrynodesApp, type KrynodesContext } from "./shared";

export function registerAgentRoutes(app: KrynodesApp): void {
  app.use("/api/agent/*", async (context, next) => {
    const limiter = context.env.AGENT_RATE_LIMIT;
    if (limiter) {
      const key = context.req.header("cf-connecting-ip") ?? "unknown";
      const { success } = await limiter.limit({ key });
      if (!success) {
        return context.json(
          { code: "RATE_LIMITED", message: "Too many agent requests." },
          429,
        );
      }
    }
    await next();
  });

  app.post("/api/agent/enroll", async (context) => {
    const token = readBearerToken(context.req.header("authorization"));
    const host = hostSchema.safeParse(await readJson(context));
    if (!token || !host.success) {
      return context.json({ code: "INVALID_ENROLLMENT" }, 400);
    }

    const db = context.env.DB;
    const invite = await db
      .prepare(
        `SELECT id, owner_user_id, interval_seconds FROM enrollment_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .bind(await sha256(token), new Date().toISOString())
      .first<{ id: string; owner_user_id: string; interval_seconds: number }>();
    if (!invite) return context.json({ code: "INVALID_ENROLLMENT" }, 401);

    const nodeId = crypto.randomUUID();
    const agentToken = randomToken();
    const [created] = await db.batch([
      db
        .prepare(
          `INSERT INTO nodes (
           id, owner_user_id, name, agent_token_hash, interval_seconds,
           enrolled_at, hostname, operating_system, architecture,
           agent_version, last_seen_at
         )
         SELECT ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, datetime('now')
         WHERE EXISTS (
           SELECT 1 FROM enrollment_tokens WHERE id = ? AND used_at IS NULL
         )`,
        )
        .bind(
          nodeId,
          invite.owner_user_id,
          host.data.hostname.slice(0, 100),
          await sha256(agentToken),
          invite.interval_seconds,
          host.data.hostname,
          host.data.operatingSystem,
          host.data.architecture,
          host.data.agentVersion,
          invite.id,
        ),
      db
        .prepare(
          `UPDATE enrollment_tokens SET used_at = ?, node_id = ?
         WHERE id = ? AND used_at IS NULL`,
        )
        .bind(new Date().toISOString(), nodeId, invite.id),
    ]);
    if (!created?.meta.changes) {
      return context.json({ code: "INVALID_ENROLLMENT" }, 401);
    }

    return context.json({
      nodeId,
      token: agentToken,
      intervalSeconds: invite.interval_seconds,
    });
  });

  app.post("/api/agent/heartbeat", async (context) => {
    const node = await authenticateAgent(context);
    if (!node) return context.json({ code: "UNAUTHORIZED" }, 401);
    const heartbeat = heartbeatSchema.safeParse(await readJson(context));
    if (!heartbeat.success || heartbeat.data.nodeId !== node.id) {
      return context.json({ code: "INVALID_HEARTBEAT" }, 400);
    }

    const now = Date.now();
    const db = context.env.DB;
    const agent = await loadAgentConfig(db, node);
    const accepted = acceptResults(agent.checks, heartbeat.data.results ?? []);
    await commit(
      context.env,
      node.id,
      [
        ...heartbeatStatements(db, node, heartbeat.data, now),
        ...(await windowStatements(
          db,
          node,
          heartbeat.data.metrics,
          accepted,
          now,
        )),
      ],
      resultStatements(db, agent.checks, accepted, now),
    );
    const actions = await heartbeatActions(context.env.DB, node.id, now);
    return context.json(
      heartbeatResponse(
        node,
        agent.configVersion,
        heartbeat.data.agentVersion,
        actions,
      ),
    );
  });

  app.get("/api/agent/stream", async (context) => {
    if (!streamsOn(context.env)) {
      return context.json({ code: "STREAM_OFF" }, 404);
    }
    if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return context.json({ code: "UPGRADE_REQUIRED" }, 426);
    }
    const node = await authenticateAgent(context);
    if (!node?.owner_user_id) {
      return context.json({ code: "UNAUTHORIZED" }, 401);
    }
    const headers = new Headers();
    for (const [name, value] of context.req.raw.headers) {
      const key = name.toLowerCase();
      if (key === "authorization" || key.startsWith("x-kry-")) continue;
      headers.set(name, value);
    }
    headers.set("x-kry-node", node.id);
    headers.set("x-kry-owner", node.owner_user_id);
    headers.set("x-kry-interval", String(node.interval_seconds));
    return hubFor(context.env, node.owner_user_id).fetch(
      new Request("https://fleet/connect", { headers }),
    );
  });

  app.get("/api/agent/config", async (context) => {
    const node = await authenticateAgent(context);
    if (!node) return context.json({ code: "UNAUTHORIZED" }, 401);
    const agent = await loadAgentConfig(context.env.DB, node);
    return context.json(
      agentConfigResponseSchema.parse({
        ...agent.config,
        configVersion: agent.configVersion,
      }),
    );
  });

  app.post("/api/agent/actions", async (context) => {
    const node = await authenticateAgent(context);
    if (!node) return context.json({ code: "UNAUTHORIZED" }, 401);
    const payload = actionsSchema.safeParse(await readJson(context));
    if (!payload.success || payload.data.nodeId !== node.id) {
      return context.json({ code: "INVALID_ACTIONS" }, 400);
    }
    const db = context.env.DB;
    const now = Date.now();
    if (payload.data.results && payload.data.results.length > 0) {
      await db.batch([
        ...actionResultStatements(db, node.id, payload.data.results, now),
        ...sweepStatements(db, now),
      ]);
    }
    const inventoryHash = payload.data.inventory
      ? await applyInventory(
          db,
          {
            id: node.id,
            inventory_hash: node.inventory_hash ?? null,
            refresh_requested_at: node.refresh_requested_at ?? null,
          },
          payload.data.inventory,
          now,
        )
      : (node.inventory_hash ?? null);
    return context.json({ ok: true, inventoryHash });
  });
}

async function authenticateAgent(
  context: KrynodesContext,
): Promise<AgentNode | null> {
  const token = readBearerToken(context.req.header("authorization"));
  if (!token) return null;
  return context.env.DB.prepare(
    `SELECT id, owner_user_id, interval_seconds, update_requested_version,
            update_requested_at, inventory_hash, refresh_requested_at
     FROM nodes
     WHERE agent_token_hash = ? AND enrolled_at IS NOT NULL
       AND disabled_at IS NULL LIMIT 1`,
  )
    .bind(await sha256(token))
    .first<AgentNode>();
}
