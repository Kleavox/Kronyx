import { receiveReport } from "../actions/report";
import { heartbeatActions, inMaintenance } from "../actions/store";
import {
  acceptResults,
  commit,
  heartbeatResponse,
  heartbeatStatements,
  insertWindow,
  updateRetry,
  loadAgentConfig,
  resultStatements,
  type AgentNode,
} from "../agent/ingest";
import { windowStart } from "../agent/windows";
import type { Env } from "../env";
import {
  drain as drainMail,
  emptyBox,
  enqueue,
  nextAlarm,
  type IncidentNotice,
  type MailBox,
} from "../incident/notify";
import { sendDigestEmail, sendServerEmail } from "../lib/mail";
import { actionsSchema, heartbeatSchema } from "../schemas";
import { agentConfigResponseSchema } from "@krynodes/protocol";
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

const NODE_SQL = `SELECT id, interval_seconds, update_requested_version, update_requested_at,
         update_attempts, update_error, inventory_hash, refresh_requested_at
  FROM nodes
  WHERE id = ? AND enrolled_at IS NOT NULL AND disabled_at IS NULL`;

type Reply = (message: Record<string, unknown>) => void;

const WATCH = "watch";
const MAIL = "mail";

const watching = (ws: WebSocket) =>
  (ws.deserializeAttachment() as { watch?: boolean } | null)?.watch === true;

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
    if (url.pathname === "/watch") {
      const [client, server] = Object.values(new WebSocketPair());
      await this.watch(server!);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/announce" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        topics?: unknown;
      } | null;
      const topics = Array.isArray(body?.topics)
        ? body.topics.filter(
            (topic): topic is string => typeof topic === "string",
          )
        : [];
      if (topics.length > 0) this.announce(topics);
      return Response.json({ announced: topics.length > 0 });
    }
    if (url.pathname === "/live") {
      return Response.json(
        liveView(
          this.ctx
            .getWebSockets()
            .filter((ws) => !watching(ws))
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

  async watch(ws: WebSocket): Promise<void> {
    this.ctx.acceptWebSocket(ws, [WATCH]);
    ws.serializeAttachment({ watch: true });
  }

  announce(topics: string[]): void {
    const message = JSON.stringify({ type: "changed", topics });
    for (const ws of this.ctx.getWebSockets(WATCH)) {
      try {
        ws.send(message);
      } catch {
        continue;
      }
    }
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (watching(ws)) return;
    let body: unknown;
    try {
      body = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message),
      );
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "INVALID_MESSAGE" }));
      return;
    }
    const envelope = (body ?? {}) as {
      id?: unknown;
      type?: unknown;
      heartbeat?: unknown;
      report?: unknown;
    };
    if (typeof envelope.id !== "number") {
      ws.send(JSON.stringify({ type: "error", code: "INVALID_MESSAGE" }));
      return;
    }
    const id = envelope.id;
    const reply: Reply = (answer) => ws.send(JSON.stringify({ id, ...answer }));
    const invalid = () => reply({ type: "error", code: "INVALID_MESSAGE" });
    const state = ws.deserializeAttachment() as StreamState;
    try {
      if (envelope.type === "heartbeat") {
        const parsed = heartbeatSchema.safeParse(envelope.heartbeat);
        if (!parsed.success || parsed.data.nodeId !== state.nodeId) {
          invalid();
          return;
        }
        await this.heartbeat(ws, state, parsed.data, reply);
      } else if (envelope.type === "config") {
        const node = await this.node(ws, state);
        if (!node) return;
        const agent = await loadAgentConfig(this.env.DB, node);
        reply({
          type: "config",
          config: agentConfigResponseSchema.parse({
            ...agent.config,
            configVersion: agent.configVersion,
          }),
        });
      } else if (envelope.type === "actions") {
        const parsed = actionsSchema.safeParse(envelope.report);
        if (!parsed.success || parsed.data.nodeId !== state.nodeId) {
          invalid();
          return;
        }
        const node = await this.node(ws, state);
        if (!node) return;
        reply({
          type: "actions",
          response: await receiveReport(
            this.env.DB,
            node,
            parsed.data,
            Date.now(),
          ),
        });
        this.announce(["actions", "services"]);
      } else {
        invalid();
      }
    } catch (error) {
      console.error("[kry fleet]", error);
      reply({ type: "error", code: "SERVER_ERROR" });
    }
  }

  private async node(ws: WebSocket, state: StreamState) {
    const node = await this.env.DB.prepare(NODE_SQL)
      .bind(state.nodeId)
      .first<AgentNode>();
    if (!node) ws.close(4401, "Unknown or disabled server");
    return node;
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (watching(ws)) return;
    await this.leave(ws);
    this.announce(["nodes"]);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (watching(ws)) return;
    await this.leave(ws);
    this.announce(["nodes"]);
  }

  private async queueMail(notices: IncidentNotice[], now: number) {
    const box = enqueue(
      (await this.ctx.storage.get<MailBox>(MAIL)) ?? emptyBox(),
      notices,
      now,
    );
    await this.ctx.storage.put(MAIL, box);
    await this.ctx.storage.setAlarm(nextAlarm(box) ?? now);
  }

  async alarm(): Promise<void> {
    const { send, digest, box } = drainMail(
      (await this.ctx.storage.get<MailBox>(MAIL)) ?? emptyBox(),
      Date.now(),
    );
    await this.ctx.storage.put(MAIL, box);
    const next = nextAlarm(box);
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
    try {
      if (send.length > 0) {
        const ids = send.map((server) => server.nodeId);
        const rows = await this.env.DB.prepare(
          `SELECT id, name FROM nodes WHERE id IN (${ids.map(() => "?").join(", ")})`,
        )
          .bind(...ids)
          .all<{ id: string; name: string }>();
        const names = new Map(rows.results.map((row) => [row.id, row.name]));
        for (const server of send) {
          const nodeName = names.get(server.nodeId);
          if (nodeName) {
            await sendServerEmail(this.env, { nodeName, ...server });
          }
        }
      }
      if (digest) await sendDigestEmail(this.env, digest);
    } catch (error) {
      console.error("[kry mail]", error);
    }
  }

  private async heartbeat(
    ws: WebSocket,
    current: StreamState,
    beat: Parameters<typeof fold>[1],
    reply: Reply,
  ) {
    const db = this.env.DB;
    const now = Date.now();
    const known = await this.node(ws, current);
    if (!known) return;
    const retried = updateRetry(db, known, beat, now);
    const node = retried.node;
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
    const maintenance =
      accepted.some((result) => result.status === "DOWN") &&
      (await inMaintenance(db, node.id, now, current.connectedAt));
    const ingestion = resultStatements(
      db,
      agent.checks,
      accepted,
      now,
      maintenance,
    );
    const folded = fold(state, beat, accepted, now);
    const leading: D1PreparedStatement[] = [];
    if (folded.flushed)
      leading.push(this.flushStatement(node.id, folded.flushed));
    if (folded.writeNode) {
      leading.push(...heartbeatStatements(db, node, beat, now));
    }
    leading.push(...retried.statements);
    const notices = await commit(this.env, node.id, leading, ingestion);
    if (notices.length > 0) await this.queueMail(notices, now);
    const actions = await heartbeatActions(db, node.id, now);
    ws.serializeAttachment(folded.state);
    reply({
      type: "heartbeat",
      response: heartbeatResponse(
        node,
        agent.configVersion,
        beat.agentVersion,
        actions,
      ),
    });
    const topics = [
      ...(current.lastSeen === null ? ["nodes"] : []),
      ...(ingestion.statements.length > 0 || ingestion.transitions.length > 0
        ? ["checks"]
        : []),
      ...(actions.length > 0 ? ["actions"] : []),
    ];
    if (topics.length > 0) this.announce(topics);
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
