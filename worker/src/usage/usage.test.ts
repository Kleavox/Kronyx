import { afterEach, describe, expect, it, vi } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { createTestDb } from "../test/sqlite-d1";
import { parseUsage, usageRequest } from "./usage";

const NOW = Date.parse("2026-10-01T09:30:00.000Z");
const TOKEN = "analytics-secret-token-value";

const answer = {
  data: {
    viewer: {
      accounts: [
        {
          workers: [
            { sum: { requests: 900 }, dimensions: { scriptName: "kry" } },
            { sum: { requests: 100 }, dimensions: { scriptName: "stats" } },
            { sum: { requests: 4000 }, dimensions: { scriptName: "blog" } },
          ],
          d1: [
            {
              sum: { rowsRead: 5000, rowsWritten: 700 },
              dimensions: { databaseId: "db-kry" },
            },
            {
              sum: { rowsRead: 100, rowsWritten: 50 },
              dimensions: { databaseId: "db-blog" },
            },
          ],
          durableObjects: [{ sum: { requests: 42 } }],
        },
      ],
    },
  },
};

function setup(env: Partial<Env> = {}) {
  const { db, sqlite } = createTestDb();
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(answer), {
        headers: { "content-type": "application/json" },
      }),
  );
  const full = {
    DB: db,
    CF_ACCOUNT_ID: "acc-1",
    CF_ANALYTICS_TOKEN: TOKEN,
    KRY_D1_ID: "db-kry",
    ...env,
  } as unknown as Env;
  const call = (method = "GET", path = "/api/usage", body?: unknown) =>
    app.request(
      `https://kry.example.test${path}`,
      {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      full,
    );
  vi.stubGlobal("fetch", fetcher);
  return { sqlite, fetcher, call };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usage", () => {
  it("asks for today in UTC with the account tag", () => {
    const request = usageRequest("acc-1", NOW);
    expect(request.variables).toEqual({
      account: "acc-1",
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-10-01T09:30:00.000Z",
      date: "2026-10-01",
    });
    expect(request.query).toContain("workersInvocationsAdaptive");
    expect(request.query).toContain("d1AnalyticsAdaptiveGroups");
    expect(request.query).toContain("durableObjectsInvocationsAdaptiveGroups");
  });

  it("reads the account totals and the Krynodes share", () => {
    const usage = parseUsage(answer, {
      scripts: ["kry", "stats"],
      database: "db-kry",
    });
    expect(usage).toEqual({
      account: { requests: 5000, reads: 5100, writes: 750, objects: 42 },
      krynodes: { requests: 1000, reads: 5000, writes: 700 },
    });
    expect(
      parseUsage(answer, { scripts: ["kry", "stats"], database: null })
        .krynodes,
    ).toEqual({ requests: 1000, reads: 5100, writes: 750 });
  });

  it("refuses an answer with errors", () => {
    expect(() =>
      parseUsage(
        { errors: [{ message: "not authorized for that account" }] },
        { scripts: ["kry"], database: null },
      ),
    ).toThrow("not authorized for that account");
  });

  it("answers with real numbers, caches them for 15 minutes and never shows the token", async () => {
    const { call, fetcher } = setup();
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const response = await call();
      const text = await response.text();
      expect(text).not.toContain(TOKEN);
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(body).toMatchObject({
        source: "cloudflare",
        configured: true,
        krynodes: { requests: 1000, reads: 5000, writes: 700 },
        budget: { requests: 20000, writes: 30000, reads: 1000000 },
        resetAt: "2026-10-02T00:00:00.000Z",
      });
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${TOKEN}`,
      );
      await call();
      expect(fetcher).toHaveBeenCalledTimes(1);
      vi.setSystemTime(NOW + 16 * 60_000);
      await call();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the estimate without a token or an account", async () => {
    const { call, fetcher } = setup({ CF_ANALYTICS_TOKEN: undefined });
    const body = (await (await call()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      source: "estimate",
      configured: false,
      krynodes: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the error without retrying at once when Cloudflare refuses", async () => {
    const { call, fetcher } = setup();
    fetcher.mockImplementation(
      async () => new Response("forbidden", { status: 403 }),
    );
    const body = (await (await call()).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      source: "estimate",
      configured: true,
      error: "Cloudflare answered 403.",
    });
    await call();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stores the Krynodes share of each quota", async () => {
    const { call } = setup();
    expect(
      (await call("PUT", "/api/usage/budget", { requests: 0 })).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", "/api/usage/budget", {
          requests: 40000,
          writes: 50000,
          reads: 2000000,
        })
      ).status,
    ).toBe(200);
    const body = (await (await call()).json()) as Record<string, unknown>;
    expect(body.budget).toEqual({
      requests: 40000,
      writes: 50000,
      reads: 2000000,
    });
  });
});
