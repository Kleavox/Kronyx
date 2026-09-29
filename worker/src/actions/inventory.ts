import {
  isProtectedTarget,
  type AgentActionsRequest,
  type ServiceEntry,
} from "@krynodes/protocol";

const REPORTING_MS = 3 * 60_000;

function seenAt(value: string | null): number {
  if (value === null) return Number.NaN;
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value,
  );
}

type Inventory = NonNullable<AgentActionsRequest["inventory"]>;

export interface InventoryNode {
  id: string;
  inventory_hash: string | null;
  refresh_requested_at: string | null;
}

interface ServiceRow {
  kind: string;
  name: string;
  state: string;
  since: string | null;
  system: number;
}

const keyOf = (service: { kind: string; name: string }) =>
  `${service.kind}:${service.name}`;

function changed(row: ServiceRow | undefined, entry: ServiceEntry): boolean {
  return (
    !row ||
    row.state !== entry.state ||
    row.since !== entry.since ||
    row.system !== (entry.system ? 1 : 0)
  );
}

export async function applyInventory(
  db: D1Database,
  node: InventoryNode,
  inventory: Inventory,
  now: number,
): Promise<string | null> {
  const at = new Date(now).toISOString();
  if (inventory.hash === node.inventory_hash) {
    if (node.refresh_requested_at !== null) {
      await db
        .prepare(
          "UPDATE nodes SET inventory_at = ?, refresh_requested_at = NULL WHERE id = ?",
        )
        .bind(at, node.id)
        .run();
    }
    return node.inventory_hash;
  }
  if (!inventory.services) return node.inventory_hash;

  const incoming = inventory.services.filter(
    (entry) => !isProtectedTarget(entry.kind, entry.name),
  );
  const existing = await db
    .prepare(
      "SELECT kind, name, state, since, system FROM services WHERE node_id = ?",
    )
    .bind(node.id)
    .all<ServiceRow>();
  const before = new Map(existing.results.map((row) => [keyOf(row), row]));
  const after = new Set(incoming.map(keyOf));
  const upserts = incoming
    .filter((entry) => changed(before.get(keyOf(entry)), entry))
    .map((entry) => ({ ...entry, system: entry.system ? 1 : 0 }));
  const removed = existing.results
    .filter((row) => !after.has(keyOf(row)))
    .map(keyOf);
  await db.batch([
    ...(upserts.length > 0
      ? [
          db
            .prepare(
              `INSERT INTO services (node_id, kind, name, state, since, system, updated_at)
               SELECT ?1, json_extract(value, '$.kind'), json_extract(value, '$.name'),
                      json_extract(value, '$.state'), json_extract(value, '$.since'),
                      json_extract(value, '$.system'), ?2
               FROM json_each(?3) WHERE true
               ON CONFLICT (node_id, kind, name) DO UPDATE SET
                 state = excluded.state, since = excluded.since,
                 system = excluded.system, updated_at = excluded.updated_at`,
            )
            .bind(node.id, at, JSON.stringify(upserts)),
        ]
      : []),
    ...(removed.length > 0
      ? [
          db
            .prepare(
              `DELETE FROM services
               WHERE node_id = ?1 AND (kind || ':' || name) IN (SELECT value FROM json_each(?2))`,
            )
            .bind(node.id, JSON.stringify(removed)),
        ]
      : []),
    db
      .prepare(
        `UPDATE nodes SET inventory_hash = ?, inventory_at = ?, refresh_requested_at = NULL
         WHERE id = ?`,
      )
      .bind(inventory.hash, at, node.id),
  ]);
  return inventory.hash;
}

export async function requestRefresh(
  db: D1Database,
  ownerId: string,
  nodeIds: string[] | undefined,
  now: number,
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT id, last_seen_at FROM nodes
       WHERE owner_user_id = ? AND enrolled_at IS NOT NULL AND disabled_at IS NULL`,
    )
    .bind(ownerId)
    .all<{ id: string; last_seen_at: string | null }>();
  const wanted = rows.results.filter(
    (row) =>
      now - seenAt(row.last_seen_at) <= REPORTING_MS &&
      (!nodeIds || nodeIds.includes(row.id)),
  );
  if (wanted.length === 0) return 0;
  const at = new Date(now).toISOString();
  await db.batch(
    wanted.map((row) =>
      db
        .prepare("UPDATE nodes SET refresh_requested_at = ? WHERE id = ?")
        .bind(at, row.id),
    ),
  );
  return wanted.length;
}
