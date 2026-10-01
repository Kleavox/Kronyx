import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const NODE = "11111111-1111-4111-8111-111111111111";

function setup(bound = true) {
  const { db, sqlite } = createTestDb();
  seedNode(sqlite, { id: NODE });
  const hub: { path: string; body: string | null; owner: string }[] = [];
  const env = {
    DB: db,
    ...(bound
      ? {
          FLEET: {
            idFromName: (name: string) => ({ name }),
            get: (id: { name: string }) => ({
              fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = new Request(input, init);
                hub.push({
                  path: new URL(request.url).pathname,
                  body: request.method === "POST" ? await request.text() : null,
                  owner: id.name,
                });
                return new Response("from hub");
              },
            }),
          },
        }
      : {}),
  } as unknown as Env;
  const call = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    app.request(
      `https://kry.example.test${path}`,
      {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  return { call, hub };
}

describe("live updates for dashboards", () => {
  it("hands a dashboard's WebSocket to the owner's hub", async () => {
    const t = setup();
    expect((await t.call("GET", "/api/live")).status).toBe(426);
    const response = await t.call("GET", "/api/live", { upgrade: "websocket" });
    expect(await response.text()).toBe("from hub");
    expect(t.hub).toEqual([
      { path: "/watch", body: null, owner: "standalone" },
    ]);
    expect(
      (await setup(false).call("GET", "/api/live", { upgrade: "websocket" }))
        .status,
    ).toBe(404);
  });

  it("names what changed for checks and service refreshes", async () => {
    const t = setup();
    const created = await t.call(
      "POST",
      "/api/checks",
      {},
      {
        nodeId: NODE,
        name: "Web",
        kind: "HTTP",
        target: "https://example.com/health",
        timeoutSeconds: 5,
      },
    );
    expect(created.status).toBe(201);
    await t.call("POST", "/api/services/refresh", {}, {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      t.hub
        .filter((entry) => entry.path === "/announce")
        .map((entry) => entry.body),
    ).toEqual([
      JSON.stringify({ topics: ["checks"] }),
      JSON.stringify({ topics: ["services"] }),
    ]);
  });

  it("announces every successful dashboard change, and nothing else", async () => {
    const t = setup();
    await t.call("PATCH", `/api/nodes/${NODE}`, {}, { name: "pivox-2" });
    await t.call(
      "PATCH",
      "/api/nodes/22222222-2222-4222-8222-222222222222",
      {},
      {
        name: "missing",
      },
    );
    await t.call("GET", "/api/overview");
    await t.call("POST", "/api/agent/heartbeat", {}, {});
    expect(t.hub.filter((entry) => entry.path === "/announce")).toEqual([
      {
        path: "/announce",
        body: JSON.stringify({ topics: ["all"] }),
        owner: "standalone",
      },
    ]);
  });
});
