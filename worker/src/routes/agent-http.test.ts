import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const NODE = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const { db, sqlite } = createTestDb();
  seedNode(sqlite, { id: NODE });
  sqlite
    .prepare("UPDATE nodes SET agent_token_hash = ? WHERE id = ?")
    .run(await sha256("agent-token"), NODE);
  const env = { DB: db } as unknown as Env;
  const call = (method: string, path: string, body?: unknown, token = true) =>
    app.request(
      `https://kry.example.test${path}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer agent-token" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  return { call };
}

describe("old agent HTTP path", () => {
  it("is on until the owner turns it off, and can be turned back on", async () => {
    const t = await setup();
    const overview = async () =>
      (
        (await (await t.call("GET", "/api/overview")).json()) as {
          agentHttp: boolean;
        }
      ).agentHttp;
    expect(await overview()).toBe(true);
    expect((await t.call("GET", "/api/agent/config")).status).toBe(200);
    expect(
      (await t.call("PUT", "/api/agent-http", { enabled: "no" })).status,
    ).toBe(400);
    expect(
      (await t.call("PUT", "/api/agent-http", { enabled: false })).status,
    ).toBe(200);
    expect(await overview()).toBe(false);
    for (const [method, path] of [
      ["POST", "/api/agent/heartbeat"],
      ["GET", "/api/agent/config"],
      ["POST", "/api/agent/actions"],
    ] as const) {
      const response = await t.call(
        method,
        path,
        method === "POST" ? {} : undefined,
      );
      expect(response.status, path).toBe(410);
      expect(await response.json()).toMatchObject({
        code: "AGENT_UPDATE_REQUIRED",
      });
    }
    expect(
      (await t.call("POST", "/api/agent/enroll", {}, false)).status,
    ).not.toBe(410);
    expect(
      (await t.call("PUT", "/api/agent-http", { enabled: true })).status,
    ).toBe(200);
    expect((await t.call("GET", "/api/agent/config")).status).toBe(200);
  });
});
