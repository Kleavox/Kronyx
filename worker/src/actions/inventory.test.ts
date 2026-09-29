import type { DatabaseSync } from "node:sqlite";
import type { ServiceEntry } from "@krynodes/protocol";
import { describe, expect, it } from "vitest";

import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";
import {
  applyInventory,
  requestRefresh,
  type InventoryNode,
} from "./inventory";

const NODE = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-29T10:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SEEN = "2026-09-29 09:59:30";

const entry = (
  name: string,
  state: ServiceEntry["state"] = "running",
  kind: ServiceEntry["kind"] = "docker",
): ServiceEntry => ({ kind, name, state, since: null, system: false });

function setup() {
  const { db, sqlite } = createTestDb();
  seedNode(sqlite, { id: NODE });
  sqlite
    .prepare(
      "UPDATE nodes SET agent_version = '0.6.0', last_seen_at = ? WHERE id = ?",
    )
    .run(SEEN, NODE);
  const node = () =>
    sqlite
      .prepare(
        "SELECT id, inventory_hash, refresh_requested_at, inventory_at FROM nodes WHERE id = ?",
      )
      .get(NODE) as unknown as InventoryNode & { inventory_at: string | null };
  const rows = () =>
    sqlite
      .prepare(
        "SELECT kind, name, state, updated_at FROM services WHERE node_id = ? ORDER BY name",
      )
      .all(NODE);
  return { db, sqlite, node, rows };
}

function recordStatements(sqlite: DatabaseSync): string[] {
  const statements: string[] = [];
  const prepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  }) as typeof sqlite.prepare;
  return statements;
}

describe("applyInventory", () => {
  it("stores a new inventory and acknowledges its hash", async () => {
    const { db, node, rows } = setup();
    const stored = await applyInventory(
      db,
      node(),
      { hash: HASH_A, services: [entry("adguard"), entry("web", "stopped")] },
      NOW,
    );
    expect(stored).toBe(HASH_A);
    expect(node()).toMatchObject({
      inventory_hash: HASH_A,
      inventory_at: new Date(NOW).toISOString(),
    });
    expect(rows()).toEqual([
      expect.objectContaining({ name: "adguard", state: "running" }),
      expect.objectContaining({ name: "web", state: "stopped" }),
    ]);
  });

  it("writes only the rows that changed and deletes the ones that disappeared", async () => {
    const { db, node, rows } = setup();
    await applyInventory(
      db,
      node(),
      {
        hash: HASH_A,
        services: [entry("adguard"), entry("web"), entry("old")],
      },
      NOW,
    );
    const later = NOW + 60_000;
    await applyInventory(
      db,
      node(),
      { hash: HASH_B, services: [entry("adguard"), entry("web", "failed")] },
      later,
    );
    expect(rows()).toEqual([
      {
        kind: "docker",
        name: "adguard",
        state: "running",
        updated_at: new Date(NOW).toISOString(),
      },
      {
        kind: "docker",
        name: "web",
        state: "failed",
        updated_at: new Date(later).toISOString(),
      },
    ]);
  });

  it("writes nothing when the hash is unchanged", async () => {
    const { db, sqlite, node } = setup();
    await applyInventory(
      db,
      node(),
      { hash: HASH_A, services: [entry("adguard")] },
      NOW,
    );
    const statements = recordStatements(sqlite);
    const stored = await applyInventory(
      db,
      node(),
      { hash: HASH_A, services: [entry("adguard")] },
      NOW + 60_000,
    );
    expect(stored).toBe(HASH_A);
    expect(
      statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/iu.test(sql)),
    ).toEqual([]);
  });

  it("ends a refresh even when nothing changed", async () => {
    const { db, sqlite, node } = setup();
    await applyInventory(
      db,
      node(),
      { hash: HASH_A, services: [entry("adguard")] },
      NOW,
    );
    sqlite
      .prepare("UPDATE nodes SET refresh_requested_at = ? WHERE id = ?")
      .run(new Date(NOW + 1_000).toISOString(), NODE);
    await applyInventory(db, node(), { hash: HASH_A }, NOW + 5_000);
    expect(node()).toMatchObject({
      refresh_requested_at: null,
      inventory_at: new Date(NOW + 5_000).toISOString(),
    });
  });

  it("never stores a protected target an agent reports", async () => {
    const { db, node, rows } = setup();
    await applyInventory(
      db,
      node(),
      {
        hash: HASH_A,
        services: [
          entry("ssh.service", "running", "systemd"),
          entry("nginx.service", "running", "systemd"),
        ],
      },
      NOW,
    );
    expect(rows()).toEqual([
      expect.objectContaining({ name: "nginx.service" }),
    ]);
  });

  it("writes a large inventory in a handful of statements", async () => {
    const { db, sqlite, node, rows } = setup();
    const statements = recordStatements(sqlite);
    const many = Array.from({ length: 120 }, (_, index) => entry(`c${index}`));
    await applyInventory(db, node(), { hash: HASH_A, services: many }, NOW);
    await applyInventory(
      db,
      node(),
      { hash: HASH_B, services: many.slice(60) },
      NOW + 60_000,
    );
    expect(rows()).toHaveLength(60);
    expect(
      statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/iu.test(sql))
        .length,
    ).toBeLessThanOrEqual(6);
  });

  it("keeps the stored inventory when a new hash arrives without its services", async () => {
    const { db, node, rows } = setup();
    await applyInventory(
      db,
      node(),
      { hash: HASH_A, services: [entry("adguard")] },
      NOW,
    );
    expect(await applyInventory(db, node(), { hash: HASH_B }, NOW)).toBe(
      HASH_A,
    );
    expect(rows()).toHaveLength(1);
  });
});

describe("refresh and eligibility", () => {
  it("asks only the owner's reporting agents for a fresh inventory", async () => {
    const { db, sqlite } = setup();
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const FOREIGN = "33333333-3333-4333-8333-333333333333";
    seedNode(sqlite, { id: OTHER });
    seedNode(sqlite, { id: FOREIGN, owner: "someone-else" });
    sqlite
      .prepare(
        "UPDATE nodes SET agent_version = '0.1.0', last_seen_at = ? WHERE id = ?",
      )
      .run(SEEN, OTHER);
    sqlite
      .prepare(
        "UPDATE nodes SET agent_version = '0.6.0', last_seen_at = ? WHERE id = ?",
      )
      .run(SEEN, FOREIGN);
    expect(await requestRefresh(db, "standalone", undefined, NOW)).toBe(2);
    const flagged = sqlite
      .prepare(
        "SELECT id FROM nodes WHERE refresh_requested_at IS NOT NULL ORDER BY id",
      )
      .all()
      .map((row) => (row as { id: string }).id);
    expect(flagged).toEqual([NODE, OTHER].sort());
    expect(await requestRefresh(db, "standalone", [OTHER], NOW)).toBe(1);
  });

  it("does not ask a server that has stopped reporting", async () => {
    const { db, sqlite } = setup();
    sqlite
      .prepare("UPDATE nodes SET last_seen_at = ? WHERE id = ?")
      .run("2026-09-29 09:50:00", NODE);
    expect(await requestRefresh(db, "standalone", undefined, NOW)).toBe(0);
    sqlite
      .prepare("UPDATE nodes SET last_seen_at = NULL WHERE id = ?")
      .run(NODE);
    expect(await requestRefresh(db, "standalone", undefined, NOW)).toBe(0);
  });
});
