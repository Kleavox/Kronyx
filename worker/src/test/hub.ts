import type { Env } from "../env";
import { FleetHub } from "../fleet/hub";

export class FakeSocket {
  attachment: unknown = null;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
  send(message: string) {
    this.sent.push(message);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  replies() {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

class AutoResponse {
  request: string;
  response: string;
  constructor(request: string, response: string) {
    this.request = request;
    this.response = response;
  }
}

export function hubHarness(env: Partial<Env>) {
  if (!("WebSocketRequestResponsePair" in globalThis)) {
    Object.assign(globalThis, { WebSocketRequestResponsePair: AutoResponse });
  }
  const accepted: { ws: FakeSocket; tags: string[] }[] = [];
  const ctx = {
    acceptWebSocket(ws: FakeSocket, tags: string[]) {
      accepted.push({ ws, tags });
    },
    getWebSockets(tag?: string) {
      return accepted
        .filter(
          (entry) => !entry.ws.closed && (!tag || entry.tags.includes(tag)),
        )
        .map((entry) => entry.ws);
    },
    setWebSocketAutoResponse() {},
  };
  const hub = new FleetHub(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  let requests = 0;
  const connect = async (
    nodeId: string,
    ownerId = "standalone",
    interval = 60,
  ) => {
    const ws = new FakeSocket();
    await hub.accept(ws as unknown as WebSocket, nodeId, ownerId, interval);
    return ws;
  };
  const request = async (
    ws: FakeSocket,
    type: string,
    fields: Record<string, unknown> = {},
  ) => {
    requests += 1;
    const id = requests;
    await hub.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify({ id, type, ...fields }),
    );
    return ws.replies().find((reply) => reply.id === id) ?? null;
  };
  return { hub, accepted, connect, request };
}
