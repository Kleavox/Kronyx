import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { sha256 } from "./crypto";
import {
  ACCESS_AUD,
  ACCESS_TEAM,
  accessClaims,
  accessKeys,
  serveAccessCerts,
  signAccessToken,
} from "../test/access-token";
import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const NODE = "11111111-1111-4111-8111-111111111111";

let keys: Awaited<ReturnType<typeof accessKeys>>;

beforeAll(async () => {
  keys = await accessKeys();
});

afterEach(() => vi.unstubAllGlobals());

function production(extra: Partial<Env> = {}) {
  const { db, sqlite } = createTestDb();
  seedNode(sqlite, { id: NODE });
  const env = {
    DB: db,
    ENVIRONMENT: "production",
    ACCESS_TEAM_DOMAIN: ACCESS_TEAM,
    ACCESS_AUD,
    ...extra,
  } as unknown as Env;
  const call = (path: string, token?: string) =>
    app.request(
      `https://kry.example.test${path}`,
      { headers: token ? { "cf-access-jwt-assertion": token } : {} },
      env,
    );
  return { call };
}

describe("production", () => {
  it("refuses to serve at all when Access does not guard it", async () => {
    const { call } = production({
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
    });
    expect((await call("/api/overview")).status).toBe(500);
    expect((await call("/api/session")).status).toBe(500);
  });

  it("lets the operator in through Cloudflare Access as the standalone owner", async () => {
    serveAccessCerts(keys.jwk);
    const { call } = production();
    const token = await signAccessToken(
      keys.privateKey,
      accessClaims(Date.now()),
    );

    const session = await call("/api/session", token);
    expect(await session.json()).toEqual({
      authenticated: true,
      via: "access",
      identity: {
        id: "standalone",
        email: "operator@example.test",
        username: null,
      },
    });

    const overview = await call("/api/overview", token);
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as { nodes: { id: string }[] };
    expect(body.nodes.map((node) => node.id)).toEqual([NODE]);
  });

  it("answers 401 to a request that skipped Access", async () => {
    serveAccessCerts(keys.jwk);
    const { call } = production();
    expect((await call("/api/overview")).status).toBe(401);
    expect(await (await call("/api/session")).json()).toEqual({
      authenticated: false,
      via: "access",
    });
  });
});

describe("agents behind Access", () => {
  it("report with their bearer token alone, since an agent cannot pass Access", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: NODE });
    sqlite
      .prepare("UPDATE nodes SET agent_token_hash = ? WHERE id = ?")
      .run(await sha256("agent-token"), NODE);
    const response = await app.request(
      "https://kry.example.test/api/agent/config",
      { headers: { authorization: "Bearer agent-token" } },
      {
        DB: db,
        ENVIRONMENT: "production",
        ACCESS_TEAM_DOMAIN: ACCESS_TEAM,
        ACCESS_AUD,
      } as unknown as Env,
    );
    expect(response.status).toBe(200);
  });
});

describe("development", () => {
  it("still opens as the standalone operator", async () => {
    const response = await app.request(
      "https://kry.example.test/api/session",
      {},
      { ENVIRONMENT: "development" } as unknown as Env,
    );
    expect(await response.json()).toMatchObject({
      authenticated: true,
      via: "standalone",
      identity: { id: "standalone" },
    });
  });
});

describe("agent rate limit", () => {
  function limited(success: boolean) {
    const limit = vi.fn(async () => ({ success }));
    const { db } = createTestDb();
    const env = {
      DB: db,
      ENVIRONMENT: "development",
      AGENT_RATE_LIMIT: { limit },
    } as unknown as Env;
    const call = () =>
      app.request(
        "https://kry.example.test/api/agent/config",
        { headers: { "cf-connecting-ip": "203.0.113.7" } },
        env,
      );
    return { limit, call };
  }

  it("answers 429 once an address goes over its limit", async () => {
    const { limit, call } = limited(false);
    const response = await call();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
  });

  it("lets an address under its limit through to the token check", async () => {
    const { call } = limited(true);
    expect((await call()).status).toBe(401);
  });
});
