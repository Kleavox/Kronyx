import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import {
  OWNER,
  seedCheck,
  seedIncident,
  seedNode,
  seedResult,
  sqliteTime,
} from "../test/seed";
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

  it("seeks the window primary key per server, not a table scan", async () => {
    const { db } = setup();
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${CHECK_RESULTS_SQL}`)
      .bind(OWNER, ago(4 * 3_600_000))
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join(" | ");
    expect(details).not.toMatch(/SCAN w\b/u);
    expect(details).toMatch(
      /SEARCH w USING PRIMARY KEY \(node_id=\? AND window_start>\?\)/u,
    );
  });
});

describe("GET /api/incidents/:id", () => {
  const open = (db: D1Database, id: string) =>
    app.request(`https://kry.example.test/api/incidents/${id}`, {}, {
      DB: db,
    } as unknown as Env);

  it("returns the incident with the results around it, newest first", async () => {
    const { db, sqlite } = setup();
    seedIncident(sqlite, {
      id: "i1",
      checkId: "c1",
      status: "OPEN",
      startedAt: sqliteTime(new Date(Date.now() - 30 * 60_000)),
    });
    seedResult(sqlite, "c1", ago(2 * 3_600_000), "UP");
    seedResult(sqlite, "c1", ago(35 * 60_000), "DOWN", null);
    seedResult(sqlite, "c1", ago(20 * 60_000), "DOWN", null);
    seedResult(sqlite, "c1", ago(10 * 60_000), "UP", 42);
    const response = await open(db, "i1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      incident: Record<string, unknown>;
      results: {
        status: string;
        latencyMs: number | null;
        message: string | null;
      }[];
    };
    expect(body.incident).toMatchObject({
      id: "i1",
      status: "OPEN",
      check_name: "c1",
      check_kind: "HTTP",
      check_target: "https://example.com/health",
      node_id: "n1",
    });
    expect(body.results.map((result) => result.status)).toEqual([
      "UP",
      "DOWN",
      "DOWN",
    ]);
    expect(body.results[1]).toMatchObject({
      latencyMs: null,
      message: "timeout",
    });
  });

  it("answers 404 for an unknown incident or someone else's", async () => {
    const { db, sqlite } = setup();
    seedNode(sqlite, { id: "n2", owner: "someone-else" });
    seedCheck(sqlite, { id: "c2", nodeId: "n2" });
    seedIncident(sqlite, {
      id: "i2",
      checkId: "c2",
      status: "RESOLVED",
      startedAt: sqliteTime(new Date()),
    });
    expect((await open(db, "missing")).status).toBe(404);
    expect((await open(db, "i2")).status).toBe(404);
  });
});
