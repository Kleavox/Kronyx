import { describe, expect, it } from "vitest";

import {
  seedCheck,
  seedIncident,
  seedMetric,
  seedNode,
  seedResult,
  sqliteTime,
} from "./seed";
import { createTestDb } from "./sqlite-d1";

describe("SQLite D1 stand-in", () => {
  it("applies every migration", async () => {
    const { db } = createTestDb();
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(
      expect.arrayContaining(["nodes", "checks", "incidents", "node_windows"]),
    );
  });

  it("has no projects or notes tables", async () => {
    const { db } = createTestDb();
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'notes')",
      )
      .all<{ name: string }>();
    expect(tables.results).toEqual([]);
  });

  it("cascades a node delete to metrics, checks, results and incidents", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "n1" });
    seedMetric(sqlite, "n1", sqliteTime(new Date()));
    seedCheck(sqlite, { id: "c1", nodeId: "n1" });
    seedResult(sqlite, "c1", new Date().toISOString(), "DOWN");
    seedIncident(sqlite, {
      id: "i1",
      checkId: "c1",
      status: "OPEN",
      startedAt: new Date().toISOString(),
    });

    await db.prepare("DELETE FROM nodes WHERE id = ?").bind("n1").run();

    for (const table of ["node_windows", "checks", "incidents"]) {
      const row = sqlite
        .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
        .get() as { total: number };
      expect(row.total, table).toBe(0);
    }
  });

  it("binds numbered parameters the way D1 does, reused or not", async () => {
    const { db } = createTestDb();
    const row = await db
      .prepare("SELECT ?1 AS a, ?2 AS b, ?1 * 2 AS c")
      .bind(3, "x")
      .first<{ a: number; b: string; c: number }>();
    expect(row).toEqual({ a: 3, b: "x", c: 6 });
  });

  it("rolls a batch back when one statement fails, like D1", async () => {
    const { db, sqlite } = createTestDb();
    seedNode(sqlite, { id: "n1" });
    await expect(
      db.batch([
        db.prepare("DELETE FROM nodes WHERE id = ?").bind("n1"),
        db.prepare("INSERT INTO nowhere VALUES (1)"),
      ]),
    ).rejects.toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM nodes").get()).toEqual({
      n: 1,
    });
  });

  it("formats SQLite timestamps as UTC without a zone", () => {
    expect(sqliteTime(new Date("2026-09-27T08:05:09.123Z"))).toBe(
      "2026-09-27 08:05:09",
    );
  });
});
