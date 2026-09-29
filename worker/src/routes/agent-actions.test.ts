import type { AgentHeartbeat } from "@krynodes/protocol";
import { describe, expect, it } from "vitest";

import { createBatch } from "../actions/store";
import { app } from "../app";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const A = "11111111-1111-4111-8111-111111111111";

interface Reply {
  actions?: { id: string; kind: string; name: string; action: string }[];
  refresh?: boolean;
  ok?: boolean;
  inventoryHash?: string | null;
}

const reply = async (response: Response | Promise<Response>) =>
  (await (await response).json()) as Reply;
const B = "22222222-2222-4222-8222-222222222222";

async function setup() {
  const { db, sqlite } = createTestDb();
  for (const [id, token] of [
    [A, "token-a"],
    [B, "token-b"],
  ] as const) {
    seedNode(sqlite, { id });
    sqlite
      .prepare(
        "UPDATE nodes SET agent_token_hash = ?, agent_version = '0.6.0' WHERE id = ?",
      )
      .run(await sha256(token), id);
    sqlite
      .prepare(
        "INSERT INTO services (node_id, kind, name, state) VALUES (?, 'docker', 'adguard', 'running')",
      )
      .run(id);
  }
  const env = {
    DB: db,
    PUBLIC_ORIGIN: "https://kry.example.test",
  } as unknown as Env;
  const post = (path: string, token: string, body: unknown) =>
    app.request(
      `https://krynodes.test${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
      env,
    );
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
  return { sqlite, post, heartbeat, queue, status };
}

describe("agent service actions", () => {
  it("hands queued actions to the heartbeat once", async () => {
    const { post, heartbeat, queue, status } = await setup();
    const [action] = await queue([A]);
    const first = await reply(
      post("/api/agent/heartbeat", "token-a", heartbeat(A)),
    );
    expect(first.actions).toEqual([
      expect.objectContaining({
        id: action!.id,
        kind: "docker",
        name: "adguard",
        action: "restart",
      }),
    ]);
    expect(status(action!.id)).toBe("sent");
    const second = await reply(
      post("/api/agent/heartbeat", "token-a", heartbeat(A)),
    );
    expect(second.actions).toBeUndefined();
  });

  it("asks for a fresh inventory while a refresh is pending", async () => {
    const { sqlite, post, heartbeat } = await setup();
    sqlite
      .prepare("UPDATE nodes SET refresh_requested_at = ? WHERE id = ?")
      .run(new Date().toISOString(), A);
    const body = await reply(
      post("/api/agent/heartbeat", "token-a", heartbeat(A)),
    );
    expect(body.refresh).toBe(true);
  });

  it("records a result and gives the next server its turn", async () => {
    const { post, heartbeat, queue, status } = await setup();
    const [first, second] = await queue([A, B]);
    await post("/api/agent/heartbeat", "token-a", heartbeat(A));
    const response = await post("/api/agent/actions", "token-a", {
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
    expect(response.status).toBe(200);
    expect(await reply(response)).toEqual({
      ok: true,
      inventoryHash: null,
    });
    expect(status(first!.id)).toBe("done");
    const next = await reply(
      post("/api/agent/heartbeat", "token-b", heartbeat(B)),
    );
    expect(next.actions?.[0]?.id).toBe(second!.id);
  });

  it("ignores a result sent by another server", async () => {
    const { post, heartbeat, queue, status } = await setup();
    const [action] = await queue([A]);
    await post("/api/agent/heartbeat", "token-a", heartbeat(A));
    await post("/api/agent/actions", "token-b", {
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
    const mismatch = await post("/api/agent/actions", "token-b", {
      nodeId: A,
      inventory: { hash: "a".repeat(64) },
    });
    expect(mismatch.status).toBe(400);
  });

  it("acknowledges an inventory with its hash", async () => {
    const { post } = await setup();
    const body = await reply(
      post("/api/agent/actions", "token-a", {
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
    );
    expect(body).toEqual({ ok: true, inventoryHash: "c".repeat(64) });
  });

  it("refuses a report without a valid agent token", async () => {
    const { post } = await setup();
    const response = await post("/api/agent/actions", "wrong", {
      nodeId: A,
      inventory: { hash: "a".repeat(64) },
    });
    expect(response.status).toBe(401);
  });
});
