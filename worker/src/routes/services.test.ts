import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { runRetention } from "../index";
import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const FOREIGN = "44444444-4444-4444-8444-444444444444";

interface Reply {
  code?: string;
  batchId?: string;
  cancelled?: number;
  refreshed?: number;
  actions?: Record<string, unknown>[];
  nodes?: { id: string; services: Record<string, unknown>[] }[];
}

const reply = async (response: Response | Promise<Response>) =>
  (await (await response).json()) as Reply;

function setup() {
  const { db, sqlite } = createTestDb();
  for (const [id, version, owner] of [
    [A, "0.1.0", undefined],
    [B, "0.1.0", undefined],
    [C, "0.1.0", undefined],
    [FOREIGN, "0.1.0", "someone-else"],
  ] as const) {
    seedNode(sqlite, { id, owner });
    sqlite
      .prepare(
        "UPDATE nodes SET agent_version = ?, last_seen_at = datetime('now') WHERE id = ?",
      )
      .run(version, id);
    sqlite
      .prepare(
        "INSERT INTO services (node_id, kind, name, state) VALUES (?, 'docker', 'adguard', 'running')",
      )
      .run(id);
  }
  sqlite
    .prepare(
      "INSERT INTO services (node_id, kind, name, state, system) VALUES (?, 'systemd', 'cron.service', 'running', 1)",
    )
    .run(A);
  const env = {
    DB: db,
    PUBLIC_ORIGIN: "https://kry.example.test",
  } as unknown as Env;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(
      `https://kry.example.test${path}`,
      {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  const restart = (
    targets: { nodeId: string; kind?: string; name?: string }[],
    mode?: string,
  ) =>
    call("POST", "/api/actions", {
      action: "restart",
      ...(mode ? { mode } : {}),
      targets: targets.map((target) => ({
        kind: "docker",
        name: "adguard",
        ...target,
      })),
    });
  return { db, sqlite, env, call, restart };
}

describe("GET /api/services", () => {
  it("lists the owner's inventories and recent actions", async () => {
    const { call, restart } = setup();
    await restart([{ nodeId: A }]);
    const body = await reply(call("GET", "/api/services"));
    expect(body.nodes!.map((node) => node.id).sort()).toEqual([A, B, C].sort());
    const a = body.nodes!.find((node) => node.id === A);
    expect(a!.services).toEqual([
      {
        kind: "docker",
        name: "adguard",
        state: "running",
        since: null,
        system: false,
      },
      {
        kind: "systemd",
        name: "cron.service",
        state: "running",
        since: null,
        system: true,
      },
    ]);
    expect(body.actions).toEqual([
      expect.objectContaining({
        nodeId: A,
        kind: "docker",
        name: "adguard",
        action: "restart",
        status: "queued",
        mode: "rolling",
        position: 0,
      }),
    ]);
  });

  it("reads the day's actions through the node index", () => {
    const { sqlite } = setup();
    const plan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM actions
         WHERE node_id IN (SELECT id FROM nodes WHERE owner_user_id = ?)
           AND requested_at >= ?`,
      )
      .all()
      .map((row) => String((row as { detail: unknown }).detail))
      .join(" | ");
    expect(plan).toMatch(/USING INDEX idx_actions_node_requested/u);
    expect(plan).not.toMatch(/SCAN actions\b/u);
  });
});

describe("POST /api/actions", () => {
  it("queues a rolling batch with only the first server's turn open", async () => {
    const { sqlite, restart } = setup();
    const response = await restart([{ nodeId: A }, { nodeId: B }]);
    expect(response.status).toBe(201);
    const body = await reply(response);
    expect(body.actions).toHaveLength(2);
    const rows = sqlite
      .prepare(
        "SELECT node_id, position, deliverable_at IS NOT NULL AS open, requested_by FROM actions ORDER BY position",
      )
      .all();
    expect(rows).toEqual([
      {
        node_id: A,
        position: 0,
        open: 1,
        requested_by: "standalone@localhost",
      },
      {
        node_id: B,
        position: 1,
        open: 0,
        requested_by: "standalone@localhost",
      },
    ]);
  });

  it("opens every turn at once in parallel mode", async () => {
    const { sqlite, restart } = setup();
    await restart([{ nodeId: A }, { nodeId: B }], "parallel");
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS open FROM actions WHERE deliverable_at IS NOT NULL",
        )
        .get(),
    ).toEqual({ open: 2 });
  });

  it("refuses what it cannot or must not do", async () => {
    const { call, restart } = setup();
    expect(
      (await call("POST", "/api/actions", { action: "exec", targets: [] }))
        .status,
    ).toBe(400);
    expect((await restart([{ nodeId: A }, { nodeId: A }])).status).toBe(400);
    expect(
      (await restart([{ nodeId: A, kind: "systemd", name: "a;b.service" }]))
        .status,
    ).toBe(400);

    const protectedTarget = await restart([
      { nodeId: A, kind: "systemd", name: "ssh.service" },
    ]);
    expect(protectedTarget.status).toBe(422);
    expect((await reply(protectedTarget)).code).toBe("PROTECTED_TARGET");

    const unknown = await restart([{ nodeId: A, name: "ghost" }]);
    expect(unknown.status).toBe(422);
    expect((await reply(unknown)).code).toBe("UNKNOWN_TARGET");

    expect((await restart([{ nodeId: C }])).status).toBe(201);

    expect((await restart([{ nodeId: FOREIGN }])).status).toBe(404);

    expect((await restart([{ nodeId: A }])).status).toBe(201);
    const pending = await restart([{ nodeId: A }]);
    expect(pending.status).toBe(409);
    expect((await reply(pending)).code).toBe("ACTION_PENDING");
  });

  it("answers ACTION_PENDING when two requests race for one service", async () => {
    const { restart } = setup();
    const statuses = (
      await Promise.all([restart([{ nodeId: A }]), restart([{ nodeId: A }])])
    )
      .map((response) => response.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("finds pending actions through the status index", () => {
    const { sqlite } = setup();
    const plan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT node_id, kind, name FROM actions
         WHERE status IN ('queued', 'sent')
           AND node_id IN (SELECT value FROM json_each(?))`,
      )
      .all()
      .map((row) => String((row as { detail: unknown }).detail))
      .join(" | ");
    expect(plan).toMatch(/USING INDEX idx_actions_status_node/u);
  });
});

describe("cancel, refresh, history and retention", () => {
  it("cancels the queued part of a batch", async () => {
    const { call, restart, sqlite } = setup();
    const { batchId } = await reply(restart([{ nodeId: A }, { nodeId: B }]));
    const body = await reply(call("POST", `/api/actions/${batchId}/cancel`));
    expect(body).toEqual({ cancelled: 2 });
    expect(sqlite.prepare("SELECT DISTINCT status FROM actions").all()).toEqual(
      [{ status: "cancelled" }],
    );
  });

  it("asks every reporting agent for a fresh inventory", async () => {
    const { call } = setup();
    const response = await call("POST", "/api/services/refresh", {});
    expect(response.status).toBe(202);
    expect(await reply(response)).toEqual({ refreshed: 3 });
    expect(
      await reply(call("POST", "/api/services/refresh", { nodeIds: [C] })),
    ).toEqual({ refreshed: 1 });
  });

  it("returns a node's ten newest actions", async () => {
    const { call, sqlite } = setup();
    for (let index = 0; index < 12; index += 1) {
      sqlite
        .prepare(
          `INSERT INTO actions (id, batch_id, position, mode, node_id, kind, name, action, status, requested_by, requested_at)
           VALUES (?, ?, 0, 'rolling', ?, 'docker', 'adguard', 'restart', 'done', 'o', ?)`,
        )
        .run(
          crypto.randomUUID(),
          crypto.randomUUID(),
          A,
          new Date(Date.UTC(2026, 8, 29, 10, index)).toISOString(),
        );
    }
    const body = await reply(call("GET", `/api/nodes/${A}/actions`));
    expect(body.actions).toHaveLength(10);
    expect(body.actions![0]!.requestedAt).toBe("2026-09-29T10:11:00.000Z");
    expect((await call("GET", `/api/nodes/${FOREIGN}/actions`)).status).toBe(
      404,
    );
  });

  it("deleting a node removes its actions and services", async () => {
    const { call, restart, sqlite } = setup();
    await restart([{ nodeId: A }]);
    sqlite.prepare("DELETE FROM nodes WHERE id = ?").run(A);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM actions").get()).toEqual({
      n: 0,
    });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM services WHERE node_id = ?")
        .get(A),
    ).toEqual({ n: 0 });
    expect((await call("GET", "/api/services")).status).toBe(200);
  });

  it("forgets actions after 90 days", async () => {
    const { env, sqlite } = setup();
    for (const [id, days] of [
      ["old", 91],
      ["new", 89],
    ] as const) {
      sqlite
        .prepare(
          `INSERT INTO actions (id, batch_id, position, mode, node_id, kind, name, action, status, requested_by, requested_at)
           VALUES (?, ?, 0, 'rolling', ?, 'docker', 'adguard', 'restart', 'done', 'o', ?)`,
        )
        .run(id, id, A, new Date(Date.now() - days * 86_400_000).toISOString());
    }
    await runRetention(env);
    expect(sqlite.prepare("SELECT id FROM actions").all()).toEqual([
      { id: "new" },
    ]);
  });
});
