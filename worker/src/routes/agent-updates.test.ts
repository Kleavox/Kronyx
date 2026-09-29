import type { AgentHeartbeat } from "@krynodes/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import worker from "../index";
import { sha256 } from "../lib/crypto";
import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const NODE = "11111111-1111-4111-8111-111111111111";

afterEach(() => vi.unstubAllGlobals());

async function setup(agentVersion = "0.1.0") {
  const { db, sqlite } = createTestDb();
  seedNode(sqlite, { id: NODE });
  sqlite
    .prepare(
      "UPDATE nodes SET agent_token_hash = ?, agent_version = ? WHERE id = ?",
    )
    .run(await sha256("agent-token"), agentVersion, NODE);
  const env = {
    DB: db,
    PUBLIC_ORIGIN: "https://kry.example.test",
    AGENT_ORIGIN: "https://krynodes.example.workers.dev",
  } as unknown as Env;
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    app.request(
      `https://krynodes.test${path}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  const release = (version: string) =>
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('agent_release', ?, ?)",
      )
      .run(version, "2026-09-28T08:00:00.000Z");
  const row = () =>
    sqlite
      .prepare(
        "SELECT update_requested_version, update_requested_at, auto_update FROM nodes WHERE id = ?",
      )
      .get(NODE) as {
      update_requested_version: string | null;
      update_requested_at: string | null;
      auto_update: number;
    };
  const heartbeat = (version: string): AgentHeartbeat => ({
    nodeId: NODE,
    hostname: "web-01",
    operatingSystem: "Debian 12.10",
    architecture: "amd64",
    agentVersion: version,
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
  return { db, sqlite, env, call, release, row, heartbeat };
}

describe("POST /api/nodes/:id/update", () => {
  it("refuses until a release is known", async () => {
    const { call } = await setup();
    const response = await call("POST", `/api/nodes/${NODE}/update`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "NO_RELEASE" });
  });

  it("refuses an agent without a release version, and current ones", async () => {
    const dev = await setup("dev");
    dev.release("0.2.0");
    expect(
      await (await dev.call("POST", `/api/nodes/${NODE}/update`)).json(),
    ).toMatchObject({ code: "AGENT_CANNOT_UPDATE" });

    const current = await setup("0.2.0");
    current.release("0.2.0");
    expect(
      await (await current.call("POST", `/api/nodes/${NODE}/update`)).json(),
    ).toMatchObject({ code: "UP_TO_DATE" });
  });

  it("asks the agent to update through its next heartbeat, then forgets", async () => {
    const { call, release, row, heartbeat } = await setup();
    release("0.5.2");

    const requested = await call("POST", `/api/nodes/${NODE}/update`);
    expect(requested.status).toBe(202);
    expect(await requested.json()).toEqual({ version: "0.5.2" });
    const { update_requested_at } = row();
    expect(row().update_requested_version).toBe("0.5.2");

    const pending = await call(
      "POST",
      "/api/agent/heartbeat",
      heartbeat("0.5.1"),
      "agent-token",
    );
    expect(await pending.json()).toMatchObject({
      update: { version: "0.5.2", requestedAt: update_requested_at },
    });

    const done = await call(
      "POST",
      "/api/agent/heartbeat",
      heartbeat("0.5.2"),
      "agent-token",
    );
    expect(await done.json()).not.toHaveProperty("update");
    expect(row()).toMatchObject({
      update_requested_version: null,
      update_requested_at: null,
    });
  });
});

describe("agent release check", () => {
  it("checks GitHub on demand and queues auto-updates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: {
              location:
                "https://github.com/Kleavox/Krynodes/releases/tag/agent-v0.5.2",
            },
          }),
      ),
    );
    const { call, row, sqlite } = await setup();
    sqlite.prepare("UPDATE nodes SET auto_update = 1 WHERE id = ?").run(NODE);

    const response = await call("POST", "/api/agent-release/check");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: "0.5.2",
      requested: 1,
    });
    expect(row().update_requested_version).toBe("0.5.2");
  });

  it("runs the same check from the daily cron", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: {
              location:
                "https://github.com/Kleavox/Krynodes/releases/tag/agent-v0.5.2",
            },
          }),
      ),
    );
    const { env, row, sqlite } = await setup();
    sqlite.prepare("UPDATE nodes SET auto_update = 1 WHERE id = ?").run(NODE);
    const pending: Promise<unknown>[] = [];
    worker.scheduled({} as ScheduledController, env, {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext);
    await Promise.all(pending);
    expect(row().update_requested_version).toBe("0.5.2");
  });
});

describe("auto-update setting and overview", () => {
  it("turns auto-update on per node and shows the release to the dashboard", async () => {
    const { call, release, row } = await setup();
    release("0.5.2");
    expect(
      (await call("PATCH", `/api/nodes/${NODE}`, { autoUpdate: true })).status,
    ).toBe(200);
    expect(row().auto_update).toBe(1);

    const overview = (await (await call("GET", "/api/overview")).json()) as {
      agentRelease: unknown;
      nodes: Record<string, unknown>[];
    };
    expect(overview.agentRelease).toEqual({
      version: "0.5.2",
      checkedAt: "2026-09-28T08:00:00.000Z",
      updateCommand:
        "curl -fsSL https://krynodes.example.workers.dev/install.sh | sudo sh -s -- --update",
    });
    expect(overview.nodes[0]).toMatchObject({
      auto_update: 1,
      update_requested_version: null,
    });
  });
});
