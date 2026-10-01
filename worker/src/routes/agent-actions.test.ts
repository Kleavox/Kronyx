import type { AgentHeartbeat } from "@krynodes/protocol";
import { describe, expect, it } from "vitest";

import { createBatch } from "../actions/store";
import { hubHarness, type FakeSocket } from "../test/hub";
import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const A = "11111111-1111-4111-8111-111111111111";

interface Reply {
  actions?: { id: string; kind: string; name: string; action: string }[];
  refresh?: boolean;
  ok?: boolean;
  inventoryHash?: string | null;
}
const B = "22222222-2222-4222-8222-222222222222";

async function setup() {
  const { db, sqlite } = createTestDb();
  for (const id of [A, B]) {
    seedNode(sqlite, { id });
    sqlite
      .prepare("UPDATE nodes SET agent_version = '0.6.0' WHERE id = ?")
      .run(id);
    sqlite
      .prepare(
        "INSERT INTO services (node_id, kind, name, state) VALUES (?, 'docker', 'adguard', 'running')",
      )
      .run(id);
  }
  const hub = hubHarness({ DB: db });
  const sockets = new Map<string, FakeSocket>();
  const send = async (
    nodeId: string,
    type: string,
    fields: Record<string, unknown>,
  ) => {
    let socket = sockets.get(nodeId);
    if (!socket) {
      socket = await hub.connect(nodeId);
      sockets.set(nodeId, socket);
    }
    return (await hub.request(socket, type, fields)) ?? {};
  };
  const heartbeat = (nodeId: string): AgentHeartbeat => ({
    nodeId,
    hostname: "web-01",
    operatingSystem: "Debian 12.10",
    architecture: "amd64",
    agentVersion: "0.6.0",
    metrics: {
      cpuPercent: 10,
      memoryUsedBytes: 1,
      memoryTotalBytes: 2,
      diskUsedBytes: 1,
      diskTotalBytes: 2,
      load1: 0.1,
      load5: 0.1,
      load15: 0.1,
      uptimeSeconds: 60,
    },
  });
  const queue = async (nodes: string[]) => {
    const batch = createBatch(db, {
      action: "restart",
      mode: "rolling",
      targets: nodes.map((nodeId) => ({
        nodeId,
        kind: "docker" as const,
        name: "adguard",
      })),
      requestedBy: "owner@example.test",
      now: Date.now(),
    });
    await db.batch(batch.statements);
    return batch.actions;
  };
  const status = (id: string) =>
    (
      sqlite.prepare("SELECT status FROM actions WHERE id = ?").get(id) as {
        status: string;
      }
    ).status;
  const beat = async (nodeId: string) =>
    ((await send(nodeId, "heartbeat", { heartbeat: heartbeat(nodeId) }))
      .response ?? {}) as Reply;
  const report = (nodeId: string, report: Record<string, unknown>) =>
    send(nodeId, "actions", { report });
  return { sqlite, beat, report, queue, status };
}

describe("agent service actions", () => {
  it("hands queued actions to the heartbeat once", async () => {
    const { beat, queue, status } = await setup();
    const [action] = await queue([A]);
    expect((await beat(A)).actions).toEqual([
      expect.objectContaining({
        id: action!.id,
        kind: "docker",
        name: "adguard",
        action: "restart",
      }),
    ]);
    expect(status(action!.id)).toBe("sent");
    expect((await beat(A)).actions).toBeUndefined();
  });

  it("asks for a fresh inventory while a refresh is pending", async () => {
    const { sqlite, beat } = await setup();
    sqlite
      .prepare("UPDATE nodes SET refresh_requested_at = ? WHERE id = ?")
      .run(new Date().toISOString(), A);
    expect((await beat(A)).refresh).toBe(true);
  });

  it("records a result and gives the next server its turn", async () => {
    const { beat, report, queue, status } = await setup();
    const [first, second] = await queue([A, B]);
    await beat(A);
    const answer = await report(A, {
      nodeId: A,
      results: [
        {
          id: first!.id,
          ok: true,
          exitCode: 0,
          output: "",
          finishedAt: new Date().toISOString(),
        },
      ],
    });
    expect(answer).toMatchObject({
      type: "actions",
      response: { ok: true, inventoryHash: null },
    });
    expect(status(first!.id)).toBe("done");
    expect((await beat(B)).actions?.[0]?.id).toBe(second!.id);
  });

  it("ignores a result sent by another server", async () => {
    const { beat, report, queue, status } = await setup();
    const [action] = await queue([A]);
    await beat(A);
    await report(B, {
      nodeId: B,
      results: [
        {
          id: action!.id,
          ok: true,
          exitCode: 0,
          output: "",
          finishedAt: new Date().toISOString(),
        },
      ],
    });
    expect(status(action!.id)).toBe("sent");
    expect(
      await report(B, { nodeId: A, inventory: { hash: "a".repeat(64) } }),
    ).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
  });

  it("acknowledges an inventory with its hash", async () => {
    const { report } = await setup();
    expect(
      await report(A, {
        nodeId: A,
        inventory: {
          hash: "c".repeat(64),
          services: [
            {
              kind: "systemd",
              name: "nginx.service",
              state: "running",
              since: null,
              system: false,
            },
          ],
        },
      }),
    ).toMatchObject({
      type: "actions",
      response: { ok: true, inventoryHash: "c".repeat(64) },
    });
  });
});
