import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { OWNER, seedMetric, seedNode, sqliteTime } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";
import { epochIso, parseRange, RECENT_SQL } from "./metrics";

function get(db: D1Database, path: string) {
  return app.request(`https://krynodes.test${path}`, {}, {
    DB: db,
  } as unknown as Env);
}

const at = (epochSeconds: number) => sqliteTime(new Date(epochSeconds * 1000));
const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("GET /api/nodes/:id/metrics", () => {
  it("falls back to 6h for a missing, removed or unknown range", () => {
    expect(parseRange(undefined)).toBe("6h");
    expect(parseRange("1h")).toBe("6h");
    expect(parseRange("90d")).toBe("6h");
    expect(parseRange("toString")).toBe("6h");
    expect(parseRange("24h")).toBe("24h");
  });

  it("averages samples inside one bucket", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "n1" });
    const bucket = Math.floor(nowSeconds() / 300) * 300 - 600;
    seedMetric(sqlite, "n1", at(bucket + 10), { cpu: 20 });
    seedMetric(sqlite, "n1", at(bucket + 70), { cpu: 40 });

    const response = await get(db, "/api/nodes/n1/metrics?range=6h");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      range: string;
      bucketSeconds: number;
      points: { t: string; cpu: number; samples: number }[];
    };
    expect(body.range).toBe("6h");
    expect(body.bucketSeconds).toBe(300);
    expect(body.points).toHaveLength(1);
    expect(body.points[0]).toMatchObject({
      t: new Date(bucket * 1000).toISOString(),
      cpu: 30,
      samples: 2,
    });
  });

  it("sizes buckets per range", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "n1" });
    seedMetric(sqlite, "n1", at(nowSeconds() - 600));
    const size = async (range: string) =>
      (
        (await (
          await get(db, `/api/nodes/n1/metrics?range=${range}`)
        ).json()) as {
          bucketSeconds: number;
        }
      ).bucketSeconds;
    expect(await size("24h")).toBe(900);
    expect(await size("7d")).toBe(3600);
  });

  it("returns load 5 and 15 and nulls for missing values", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "n1" });
    seedMetric(sqlite, "n1", at(nowSeconds() - 600), {
      cpu: null,
      load5: 1.5,
      load15: 2.5,
    });

    const body = (await (
      await get(db, "/api/nodes/n1/metrics?range=6h")
    ).json()) as { points: Record<string, unknown>[] };
    expect(body.points[0]).toMatchObject({
      cpu: null,
      load5: 1.5,
      load15: 2.5,
    });
  });

  it("leaves out samples older than the range", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "n1" });
    seedMetric(sqlite, "n1", at(nowSeconds() - 7 * 3600));
    seedMetric(sqlite, "n1", at(nowSeconds() - 600));

    const body = (await (
      await get(db, "/api/nodes/n1/metrics?range=6h")
    ).json()) as { points: unknown[] };
    expect(body.points).toHaveLength(1);
  });

  it("returns 404 for a node owned by someone else", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "n1", owner: "other" });
    const response = await get(db, "/api/nodes/n1/metrics?range=6h");
    expect(response.status).toBe(404);
  });
});

describe("GET /api/metrics/recent", () => {
  type Recent = {
    nodes: Record<
      string,
      {
        slotSeconds: number;
        slots: {
          t: string;
          cpu: number | null;
          memPct: number | null;
          samples: number;
        }[];
      }
    >;
  };

  const recent = async (db: D1Database) =>
    (await (await get(db, "/api/metrics/recent")).json()) as Recent;

  it("groups each node's rows into five-minute windows", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "n1", interval: 60 });
    const window = Math.floor(nowSeconds() / 300);
    seedMetric(sqlite, "n1", at((window - 3) * 300 + 5), { cpu: 10 });
    seedMetric(sqlite, "n1", at((window - 3) * 300 + 65), { cpu: 30 });
    seedMetric(sqlite, "n1", at((window - 5) * 300 + 5), { cpu: 50 });
    seedMetric(sqlite, "n1", at((window - 40) * 300), { cpu: 90 });

    const node = (await recent(db)).nodes.n1!;
    expect(node.slotSeconds).toBe(300);
    expect(node.slots).toEqual([
      { t: epochIso((window - 5) * 300), cpu: 50, memPct: 50, samples: 1 },
      { t: epochIso((window - 3) * 300), cpu: 20, memPct: 50, samples: 2 },
    ]);
  });

  it("widens the window to the node interval, up to the 3600s maximum", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "ten", interval: 600 });
    seedNode(sqlite, { id: "hourly", interval: 3600 });
    seedNode(sqlite, { id: "fast", interval: 60 });
    seedMetric(sqlite, "ten", at(nowSeconds() - 4 * 3600));
    seedMetric(sqlite, "hourly", at(nowSeconds() - 20 * 3600));
    seedMetric(sqlite, "fast", at(nowSeconds() - 200 * 60));

    const body = await recent(db);
    expect(body.nodes.ten?.slotSeconds).toBe(600);
    expect(body.nodes.ten?.slots).toHaveLength(1);
    expect(body.nodes.hourly?.slotSeconds).toBe(3600);
    expect(body.nodes.hourly?.slots).toHaveLength(1);
    expect(body.nodes.fast).toBeUndefined();
  });

  it("excludes disabled nodes and other owners", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "off", disabled: true });
    seedNode(sqlite, { id: "theirs", owner: "other" });
    seedMetric(sqlite, "off", at(nowSeconds() - 60));
    seedMetric(sqlite, "theirs", at(nowSeconds() - 60));

    expect((await recent(db)).nodes).toEqual({});
  });

  it("reports memPct as null when the total is zero or missing", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "zero" });
    seedNode(sqlite, { id: "none" });
    seedMetric(sqlite, "zero", at(nowSeconds() - 60), {
      memUsed: 4,
      memTotal: 0,
    });
    seedMetric(sqlite, "none", at(nowSeconds() - 60), {
      memUsed: null,
      memTotal: null,
    });

    const body = await recent(db);
    expect(body.nodes.zero?.slots[0]?.memPct).toBeNull();
    expect(body.nodes.none?.slots[0]?.memPct).toBeNull();
  });

  it("seeks the metrics index per node instead of scanning a shared window", async () => {
    const { db } = createTestDb();
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${RECENT_SQL}`)
      .bind(OWNER, new Date().toISOString())
      .all<{ detail: string }>();
    expect(
      plan.results.some(
        (row) =>
          row.detail.includes("idx_node_metrics_node_id_recorded_at") &&
          row.detail.includes("recorded_at>"),
      ),
    ).toBe(true);
  });
});
