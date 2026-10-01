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
        return { run, bind: () => ({ run }) };
      },
    },
  } as unknown as Env;
  return { env, statements, run };
}

describe("Krynodes retention", () => {
  it("deletes expired history, incident and action records", async () => {
    const { env, statements, run } = retentionEnv();
    await runRetention(env);

    expect(run).toHaveBeenCalledTimes(4);
    expect(statements[0]).toContain("DELETE FROM node_windows");
    expect(statements.join("\n")).toContain("incidents");
    expect(statements[3]).toContain("FROM actions");
    expect(statements[3]).toContain("-90 days");
  });

  it("drops history windows older than eight days, by the primary key", async () => {
    const { db, sqlite } = createTestDb();
    sqlite.exec(
      "INSERT INTO nodes (id, owner_user_id, name, agent_token_hash) VALUES ('n1', 'standalone', 'pivox', 'h1')",
    );
    const day = 86_400_000;
    for (const age of [9 * day, 7 * day, 60_000]) {
      sqlite
        .prepare(
          "INSERT INTO node_windows (node_id, window_start) VALUES ('n1', ?)",
        )
        .run(new Date(Date.now() - age).toISOString());
    }
    await runRetention({ DB: db } as unknown as Env);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM node_windows").get(),
    ).toEqual({ n: 2 });
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
