import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { seedCheck, seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const NODE = "11111111-1111-4111-8111-111111111111";

const OTHER = "33333333-3333-4333-8333-333333333333";
const CHECK = "22222222-2222-4222-8222-222222222222";

function setup() {
  const { db, sqlite } = createTestDb();
  seedNode(sqlite, { id: NODE });
  seedNode(sqlite, { id: OTHER });
  seedCheck(sqlite, { id: CHECK, nodeId: NODE });
  sqlite
    .prepare(
      "UPDATE nodes SET agent_version = '0.2.0', last_seen_at = datetime('now') WHERE id = ?",
    )
    .run(NODE);
  sqlite
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('agent_release', '0.3.0', '2026-10-01T00:00:00.000Z')",
    )
    .run();
  const pokes: { owner: string; nodeIds: string[] }[] = [];
  const env = {
    DB: db,
    PUBLIC_ORIGIN: "https://kry.example.test",
    FLEET: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (input: string, init?: RequestInit) => {
          if (new URL(input).pathname === "/poke") {
            pokes.push({
              owner: id.name,
              ...(JSON.parse(String(init?.body)) as { nodeIds: string[] }),
            });
          }
          return Response.json({ poked: 1 });
        },
      }),
    },
  } as unknown as Env;
  const call = (path: string, body?: unknown, method = "POST") =>
    app.request(
      `https://kry.example.test${path}`,
      {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { call, pokes, settle };
}

describe("pokes", () => {
  it("wakes a connected server as soon as its update is requested", async () => {
    const t = setup();
    expect((await t.call(`/api/nodes/${NODE}/update`)).status).toBe(202);
    await t.settle();
    expect(t.pokes).toEqual([{ owner: "standalone", nodeIds: [NODE] }]);
  });

  it("wakes the servers asked for a fresh service list", async () => {
    const t = setup();
    expect((await t.call("/api/services/refresh", {})).status).toBe(202);
    await t.settle();
    expect(t.pokes).toEqual([{ owner: "standalone", nodeIds: [NODE] }]);
  });

  it("wakes the servers whose checks change, both of them when a check moves", async () => {
    const t = setup();
    expect(
      (await t.call(`/api/checks/${CHECK}`, { nodeId: OTHER }, "PATCH")).status,
    ).toBe(200);
    expect(
      (
        await t.call("/api/checks", {
          nodeId: NODE,
          name: "Web",
          kind: "HTTP",
          target: "https://example.com",
        })
      ).status,
    ).toBe(201);
    expect(
      (await t.call(`/api/checks/${CHECK}`, undefined, "DELETE")).status,
    ).toBe(204);
    await t.settle();
    expect(t.pokes.map((poke) => poke.nodeIds)).toEqual([
      [NODE, OTHER],
      [NODE],
      [OTHER],
    ]);
  });
});
