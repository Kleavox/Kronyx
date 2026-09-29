import { describe, expect, it, vi } from "vitest";

import worker, { runRetention } from "./index";
import type { Env } from "./env";
import { createTestDb } from "./test/sqlite-d1";

function retentionEnv() {
  const statements: string[] = [];
  const run = vi.fn(async () => ({ success: true }));
  const env = {
    DB: {
      prepare(sql: string) {
        statements.push(sql);
        return { run };
      },
    },
  } as unknown as Env;
  return { env, statements, run };
}

describe("Krynodes retention", () => {
  it("deletes expired metric, check, and incident records", async () => {
    const { env, statements, run } = retentionEnv();
    await runRetention(env);

    expect(run).toHaveBeenCalledTimes(5);
    expect(statements.join("\n")).toContain("node_metrics");
    expect(statements.join("\n")).toContain("check_results");
    expect(statements.join("\n")).toContain("incidents");
    expect(statements[4]).toContain("FROM actions");
    expect(statements[4]).toContain("-90 days");
    expect(statements[0]).toContain("-8 days");
    expect(statements[1]).toContain("-8 days");
  });

  it("forgets enrollment tokens a day after they expire", async () => {
    const { db, sqlite } = createTestDb();
    const insert = sqlite.prepare(
      `INSERT INTO enrollment_tokens (id, owner_user_id, token_hash, expires_at)
       VALUES (?, 'standalone', ?, ?)`,
    );
    insert.run(
      "stale",
      "hash-stale",
      new Date(Date.now() - 2 * 86_400_000).toISOString(),
    );
    insert.run(
      "fresh",
      "hash-fresh",
      new Date(Date.now() + 60_000).toISOString(),
    );

    await runRetention({ DB: db } as unknown as Env);

    expect(sqlite.prepare("SELECT id FROM enrollment_tokens").all()).toEqual([
      { id: "fresh" },
    ]);
  });

  it("runs retention and the agent release check from the cron", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    const { db } = createTestDb();
    const pending: Promise<unknown>[] = [];
    worker.scheduled(
      {} as ScheduledController,
      { DB: db } as unknown as Env,
      {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      } as unknown as ExecutionContext,
    );
    expect(pending).toHaveLength(2);
    await Promise.all(pending);
    vi.unstubAllGlobals();
  });
});
