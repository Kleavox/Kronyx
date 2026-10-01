import { heartbeatActions } from "../actions/store";
import {
  acceptResults,
  commit,
  heartbeatResponse,
  heartbeatStatements,
  insertWindow,
  loadAgentConfig,
  resultStatements,
  type AgentNode,
} from "../agent/ingest";
import { windowStart } from "../agent/windows";
import type { Env } from "../env";
import { heartbeatSchema } from "../schemas";
import {
  drain,
  fold,
  liveView,
  newState,
  resumeWindow,
  type Flush,
  type StoredWindow,
  type StreamState,
} from "./stream";

const invalid = JSON.stringify({ type: "error", code: "INVALID_MESSAGE" });

export class FleetHub {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      const nodeId = request.headers.get("x-kry-node");
      const ownerId = request.headers.get("x-kry-owner");
      const interval = Number(request.headers.get("x-kry-interval") ?? "60");
      if (!nodeId || !ownerId) return new Response(null, { status: 400 });
      const [client, server] = Object.values(new WebSocketPair());
      await this.accept(server!, nodeId, ownerId, interval);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/live") {
      return Response.json(
        liveView(
          this.ctx
            .getWebSockets()
            .map((ws) => ws.deserializeAttachment() as StreamState),
        ),
      );
    }
    if (url.pathname === "/poke" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        nodeIds?: unknown;
      } | null;
      const nodeIds = Array.isArray(body?.nodeIds)
        ? body.nodeIds.filter((id): id is string => typeof id === "string")
        : [];
      let poked = 0;
      for (const nodeId of nodeIds) {
        for (const ws of this.ctx.getWebSockets(nodeId)) {
          ws.send(JSON.stringify({ type: "poke" }));
          poked += 1;
        }
      }
      return Response.json({ poked });
    }
    return new Response(null, { status: 404 });
  }

  async accept(
    ws: WebSocket,
    nodeId: string,
    ownerId: string,
    interval: number,
  ): Promise<void> {
    for (const old of this.ctx.getWebSockets(nodeId)) {
      await this.leave(old);
      old.close(4000, "Replaced by a newer connection");
    }
    this.ctx.acceptWebSocket(ws, [nodeId]);
    ws.serializeAttachment(newState(nodeId, ownerId, interval));
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message),
      );
    } catch {
      ws.send(invalid);
      return;
    }
    const state = ws.deserializeAttachment() as StreamState;
    const envelope = body as { type?: unknown; heartbeat?: unknown };
    const parsed = heartbeatSchema.safeParse(envelope.heartbeat);
    if (
      envelope.type !== "heartbeat" ||
      !parsed.success ||
      parsed.data.nodeId !== state.nodeId
    ) {
      ws.send(invalid);
      return;
    }
    try {
      await this.heartbeat(ws, state, parsed.data);
    } catch (error) {
      console.error("[kry fleet]", error);
      ws.send(JSON.stringify({ type: "error", code: "SERVER_ERROR" }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  private async heartbeat(
    ws: WebSocket,
    current: StreamState,
    beat: Parameters<typeof fold>[1],
  ) {
    const db = this.env.DB;
    const now = Date.now();
    const node = await db
      .prepare(
        `SELECT id, interval_seconds, update_requested_version, update_requested_at,
                inventory_hash, refresh_requested_at
         FROM nodes
         WHERE id = ? AND enrolled_at IS NOT NULL AND disabled_at IS NULL`,
      )
      .bind(current.nodeId)
      .first<AgentNode>();
    if (!node) {
      ws.close(4401, "Unknown or disabled server");
      return;
    }
    let state: StreamState = { ...current, interval: node.interval_seconds };
    if (state.lastSeen === null) {
      const row = await db
        .prepare(
          `SELECT window_start, samples, cpu_percent, memory_used_bytes,
                  memory_total_bytes, disk_used_bytes, disk_total_bytes, load_1,
                  load_5, load_15, uptime_seconds, checks
           FROM node_windows WHERE node_id = ? AND window_start = ?`,
        )
        .bind(node.id, windowStart(now, node.interval_seconds))
        .first<StoredWindow>();
      state = resumeWindow(state, row, now);
    }
    const agent = await loadAgentConfig(db, node);
    const accepted = acceptResults(agent.checks, beat.results ?? []);
    const folded = fold(state, beat, accepted, now);
    const leading: D1PreparedStatement[] = [];
    if (folded.flushed)
      leading.push(this.flushStatement(node.id, folded.flushed));
    if (folded.writeNode) {
      leading.push(...heartbeatStatements(db, node, beat, now, "stream"));
    }
    await commit(
      this.env,
      node.id,
      leading,
      resultStatements(db, agent.checks, accepted, now),
    );
    const actions = await heartbeatActions(db, node.id, now);
    ws.serializeAttachment(folded.state);
    ws.send(
      JSON.stringify({
        type: "heartbeat",
        response: heartbeatResponse(
          node,
          agent.configVersion,
          beat.agentVersion,
          actions,
        ),
      }),
    );
  }

  private flushStatement(nodeId: string, flush: Flush) {
    return insertWindow(
      this.env.DB,
      nodeId,
      flush.start,
      flush.samples,
      flush.metrics,
      flush.checks,
    );
  }

  private async leave(ws: WebSocket) {
    const state = ws.deserializeAttachment() as StreamState | null;
    if (!state) return;
    const drained = drain(state);
    ws.serializeAttachment(drained.state);
    const statements: D1PreparedStatement[] = [];
    if (drained.flushed) {
      statements.push(this.flushStatement(state.nodeId, drained.flushed));
    }
    if (state.beat && state.lastSeen !== null) {
      statements.push(
        ...heartbeatStatements(
          this.env.DB,
          { id: state.nodeId, interval_seconds: state.interval },
          state.beat,
          state.lastSeen,
          "stream",
        ),
      );
    }
    if (statements.length === 0) return;
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      console.error("[kry fleet]", error);
    }
  }
}
