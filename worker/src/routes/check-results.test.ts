import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { OWNER, seedCheck, seedNode, seedResult } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";
import { CHECK_RESULTS_SQL } from "./check-results";

type Results = {
  windowSeconds: number;
  from: string;
  checks: Record<
    string,
    {
      results: {
        t: string;
        status: string;
        latencyMs: number | null;
        message: string | null;
      }[];
      up4h: number | null;
    }
  >;
};

async function results(db: D1Database): Promise<Results> {
  const response = await app.request(
    "https://kry.example.test/api/checks/results",
    {},
    { DB: db } as unknown as Env,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Results;
}

const ago = (milliseconds: number) =>
  new Date(Date.now() - milliseconds).toISOString();

function setup() {
  const { db, sqlite } = createTestDb();
  seedNode(sqlite, { id: "n1" });
  seedCheck(sqlite, { id: "c1", nodeId: "n1" });
  return { db, sqlite };
}

describe("GET /api/checks/results", () => {
  it("returns the windows of the last four hours, oldest first", async () => {
    const { db, sqlite } = setup();
    for (let index = 0; index < 60; index += 1) {
      seedResult(sqlite, "c1", ago(index * 300_000 + 30_000), "UP", index);
    }

    const body = await results(db);
    expect(body.windowSeconds).toBe(300);
    const entry = body.checks.c1!;
    expect(entry.results).toHaveLength(48);
    expect(entry.results[0]?.latencyMs).toBe(47);
    expect(entry.results[47]?.latencyMs).toBe(0);
  });

  it("computes uptime over the returned windows only", async () => {
    const { db, sqlite } = setup();
    seedResult(sqlite, "c1", ago(5 * 60_000), "UP");
    seedResult(sqlite, "c1", ago(10 * 60_000), "UP");
    seedResult(sqlite, "c1", ago(15 * 60_000), "UP");
    seedResult(sqlite, "c1", ago(20 * 60_000), "DOWN");
    seedResult(sqlite, "c1", ago(5 * 3_600_000), "DOWN");

    expect((await results(db)).checks.c1?.up4h).toBe(75);
  });

  it("leaves out a check whose results are all older than four hours", async () => {
    const { db, sqlite } = setup();
    seedResult(sqlite, "c1", ago(5 * 3_600_000), "UP");

    expect((await results(db)).checks.c1).toBeUndefined();
  });

  it("keeps another owner's checks out", async () => {
    const { db, sqlite } = setup();
    seedNode(sqlite, { id: "n2", owner: "other" });
    seedCheck(sqlite, { id: "c2", nodeId: "n2" });
    seedResult(sqlite, "c2", ago(60_000), "UP");

    expect((await results(db)).checks).toEqual({});
  });

  it("seeks the results index per check, not a table scan", async () => {
    const { db } = setup();
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${CHECK_RESULTS_SQL}`)
      .bind(OWNER, ago(4 * 3_600_000))
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    expect(details).not.toContain("SCAN r");
    expect(
      details.some((detail) =>
        detail.includes("idx_check_results_check_id_checked_at"),
      ),
    ).toBe(true);
  });
});
