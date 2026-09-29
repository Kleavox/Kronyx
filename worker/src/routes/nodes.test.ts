import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const NODE = "11111111-1111-4111-8111-111111111111";

function setup() {
  const { db, sqlite } = createTestDb();
  seedNode(sqlite, { id: NODE });
  const patch = (id: string, body: unknown) =>
    app.request(
      `https://krynodes.test/api/nodes/${id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      { DB: db } as unknown as Env,
    );
  const interval = () =>
    (
      sqlite
        .prepare("SELECT interval_seconds AS n FROM nodes WHERE id = ?")
        .get(NODE) as { n: number }
    ).n;
  return { db, sqlite, patch, interval };
}

describe("PATCH /api/nodes/:id", () => {
  it.each([300, 30, 14])(
    "keeps the one-minute interval when asked for %s seconds",
    async (value) => {
      const { patch, interval } = setup();
      expect((await patch(NODE, { intervalSeconds: value })).status).toBe(400);
      expect(
        (await patch(NODE, { name: "edge", intervalSeconds: value })).status,
      ).toBe(200);
      expect(interval()).toBe(60);
    },
  );

  it("renames a node, and refuses an empty change", async () => {
    const { sqlite, patch } = setup();
    const name = () =>
      (
        sqlite.prepare("SELECT name FROM nodes WHERE id = ?").get(NODE) as {
          name: string;
        }
      ).name;
    expect((await patch(NODE, { name: "  edge-02  " })).status).toBe(200);
    expect(name()).toBe("edge-02");
    expect((await patch(NODE, {})).status).toBe(400);
    expect((await patch(NODE, { name: "   " })).status).toBe(400);
    expect(name()).toBe("edge-02");
  });

  it("does not touch another owner's node", async () => {
    const { sqlite, patch } = setup();
    const other = "33333333-3333-4333-8333-333333333333";
    seedNode(sqlite, { id: other, owner: "someone-else" });
    expect((await patch(other, { name: "mine" })).status).toBe(404);
    expect(
      sqlite.prepare("SELECT name FROM nodes WHERE id = ?").get(other),
    ).not.toEqual({ name: "mine" });
  });
});
