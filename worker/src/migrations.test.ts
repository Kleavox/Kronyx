import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function apply(sqlite: DatabaseSync, pick: (name: string) => boolean) {
  for (const name of FILES.filter(pick)) {
    sqlite.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  }
}

const action = (
  id: string,
  kind: string,
  name: string,
  verb: string,
  status: string,
  signed: string | null = null,
) =>
  `INSERT INTO actions (id, batch_id, position, mode, node_id, kind, name, action,
     status, requested_by, requested_at, deliverable_at${signed === null ? "" : ", signed"})
   VALUES ('${id}', 'b-${id}', 0, 'rolling', 'n1', '${kind}', '${name}', '${verb}',
     '${status}', 'owner', '2026-09-29T10:00:00.000Z', '2026-09-29T10:00:00.000Z'${signed === null ? "" : `, '${signed}'`})`;

function before0014() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  apply(sqlite, (name) => name < "0014");
  sqlite.exec(
    "INSERT INTO nodes (id, owner_user_id, name, agent_token_hash) VALUES ('n1', 'standalone', 'pivox', 'h1')",
  );
  sqlite.exec(action("a1", "docker", "adguard", "restart", "done"));
  sqlite.exec(action("a2", "systemd", "nginx.service", "stop", "queued"));
  return sqlite;
}

describe("migration 0014", () => {
  it("keeps 4a actions and every index", () => {
    const sqlite = before0014();
    apply(sqlite, (name) => name.startsWith("0014"));
    expect(
      sqlite
        .prepare(
          "SELECT id, kind, action, status, signed FROM actions ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "a1",
        kind: "docker",
        action: "restart",
        status: "done",
        signed: null,
      },
      {
        id: "a2",
        kind: "systemd",
        action: "stop",
        status: "queued",
        signed: null,
      },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'actions' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual([
      "idx_actions_batch",
      "idx_actions_node_requested",
      "idx_actions_one_pending",
      "idx_actions_status_node",
    ]);
    expect(() =>
      sqlite.exec(action("a3", "systemd", "nginx.service", "start", "queued")),
    ).toThrow(/UNIQUE/u);
  });

  it("accepts compose deploys, rollbacks and trust changes, and nothing else", () => {
    const sqlite = before0014();
    apply(sqlite, (name) => name.startsWith("0014"));
    sqlite.exec(action("c1", "compose", "listmonk", "deploy", "done", "{}"));
    sqlite.exec(
      action("c2", "compose", "listmonk", "rollback", "queued", "{}"),
    );
    sqlite.exec(action("t1", "trust", "devices", "trust", "queued", "{}"));
    expect(() =>
      sqlite.exec(action("x1", "kubernetes", "web", "deploy", "queued")),
    ).toThrow(/CHECK/u);
    expect(() =>
      sqlite.exec(action("x2", "compose", "shop", "exec", "queued")),
    ).toThrow(/CHECK/u);
  });

  it("adds devices, stacks and the node's trust", () => {
    const sqlite = before0014();
    apply(sqlite, (name) => name.startsWith("0014"));
    sqlite.exec(
      "INSERT INTO devices (id, owner_user_id, name, alg, public_key, created_at) VALUES ('d1', 'standalone', 'Laptop', -7, 'MFkw', '2026-09-29T10:00:00.000Z')",
    );
    expect(() =>
      sqlite.exec(
        "INSERT INTO devices (id, owner_user_id, name, alg, public_key, created_at) VALUES ('d2', 'standalone', 'Old', -8, 'MFkw', '2026-09-29T10:00:00.000Z')",
      ),
    ).toThrow(/CHECK/u);
    sqlite.exec(
      "INSERT INTO stacks (node_id, project, directory, running, total, compose, rollback, updated_at) VALUES ('n1', 'listmonk', '/opt/listmonk', 5, 5, 1, 0, '2026-09-29T10:00:00.000Z')",
    );
    sqlite.exec(
      "UPDATE nodes SET trust_version = 1, trust_keys = '[\"0123456789abcdef\"]' WHERE id = 'n1'",
    );
    sqlite.exec("DELETE FROM nodes WHERE id = 'n1'");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM stacks").get()).toEqual({
      n: 0,
    });
  });
});

describe("migration 0015", () => {
  it("keeps every action and index and accepts a server restart", () => {
    const sqlite = before0014();
    apply(sqlite, (name) => name >= "0014" && name < "0015");
    sqlite.exec(action("c1", "compose", "listmonk", "deploy", "done", "{}"));
    apply(sqlite, (name) => name.startsWith("0015"));
    expect(
      sqlite.prepare("SELECT id, kind, signed FROM actions ORDER BY id").all(),
    ).toEqual([
      { id: "a1", kind: "docker", signed: null },
      { id: "a2", kind: "systemd", signed: null },
      { id: "c1", kind: "compose", signed: "{}" },
    ]);
    sqlite.exec(action("h1", "host", "server", "reboot", "queued", "{}"));
    expect(() =>
      sqlite.exec(action("h2", "host", "server", "exec", "queued", "{}")),
    ).toThrow();
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'actions' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual([
      "idx_actions_batch",
      "idx_actions_node_requested",
      "idx_actions_one_pending",
      "idx_actions_status_node",
    ]);
  });
});
