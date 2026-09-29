import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { seedCheck, seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const NODE = "11111111-1111-4111-8111-111111111111";
const CHECK = "22222222-2222-4222-8222-222222222222";

function setup() {
  const { db, sqlite } = createTestDb();
  seedNode(sqlite, { id: NODE });
  seedCheck(sqlite, { id: CHECK, nodeId: NODE });
  const env = { DB: db } as unknown as Env;
  const patch = (body: unknown) =>
    app.request(
      `https://krynodes.test/api/checks/${CHECK}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  const row = () =>
    sqlite
      .prepare("SELECT public, public_note FROM checks WHERE id = ?")
      .get(CHECK);
  return { env, patch, row };
}

describe("public check fields", () => {
  it("starts hidden without a note", () => {
    expect(setup().row()).toEqual({ public: 0, public_note: null });
  });

  it("publishes with a trimmed note, clears an empty note, and keeps the note when hidden", async () => {
    const { patch, row } = setup();
    expect(
      (await patch({ public: true, publicNote: "  Main website  " })).status,
    ).toBe(200);
    expect(row()).toEqual({ public: 1, public_note: "Main website" });
    expect((await patch({ public: false })).status).toBe(200);
    expect(row()).toEqual({ public: 0, public_note: "Main website" });
    expect((await patch({ publicNote: "   " })).status).toBe(200);
    expect(row()).toEqual({ public: 0, public_note: null });
  });

  it.each([{ publicNote: "x".repeat(201) }, { public: "yes" }, { public: 1 }])(
    "refuses %j",
    async (body) => {
      const { patch, row } = setup();
      expect((await patch(body)).status).toBe(400);
      expect(row()).toEqual({ public: 0, public_note: null });
    },
  );

  it("returns both fields in the overview", async () => {
    const { env, patch } = setup();
    await patch({ public: true, publicNote: "DNS" });
    const overview = (await (
      await app.request("https://krynodes.test/api/overview", {}, env)
    ).json()) as { checks: { public: number; public_note: string | null }[] };
    expect(overview.checks[0]).toMatchObject({ public: 1, public_note: "DNS" });
  });
});
