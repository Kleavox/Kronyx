import type { AgentActionResult } from "@krynodes/protocol";

const ACTION_TTL_MS = 10 * 60_000;
const ABANDON_MS = 15 * 60_000;
const COMPOSE_ABANDON_MS = 30 * 60_000;

export type ActionKind = "systemd" | "docker" | "compose" | "trust" | "host";
export type ActionVerb =
  "start" | "stop" | "restart" | "deploy" | "rollback" | "trust" | "reboot";
export type BatchMode = "rolling" | "parallel";
type ActionStatus =
  "queued" | "sent" | "done" | "failed" | "expired" | "cancelled" | "skipped";

interface ActionTarget {
  id?: string;
  nodeId: string;
  kind: ActionKind;
  name: string;
  signed?: unknown;
}

export interface ActionRow {
  id: string;
  batch_id: string;
  position: number;
  mode: BatchMode;
  node_id: string;
  kind: ActionKind;
  name: string;
  action: ActionVerb;
  status: ActionStatus;
  requested_by: string;
  requested_at: string;
  deliverable_at: string | null;
  sent_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  output: string | null;
  signed: string | null;
}

export const DELIVER_SQL = `UPDATE actions SET status = 'sent', sent_at = ?1
  WHERE id IN (
    SELECT id FROM actions
    WHERE status = 'queued' AND node_id = ?2 AND deliverable_at IS NOT NULL
    ORDER BY rowid LIMIT 10)
  RETURNING id, kind, name, action, deliverable_at, signed`;

export const EXPIRE_SQL = `UPDATE actions SET status = 'expired', finished_at = ?1
  WHERE status = 'queued' AND deliverable_at IS NOT NULL AND deliverable_at < ?2`;

const ABANDON_SQL = `UPDATE actions
  SET status = 'failed', finished_at = ?1, output = 'No result from the server'
  WHERE status = 'sent'
    AND sent_at < CASE WHEN kind = 'compose' THEN ?3 ELSE ?2 END`;

const SKIP_SQL = `UPDATE actions SET status = 'skipped', finished_at = ?1
  WHERE status = 'queued' AND deliverable_at IS NULL AND EXISTS (
    SELECT 1 FROM actions earlier
    WHERE earlier.batch_id = actions.batch_id
      AND earlier.position < actions.position
      AND earlier.status IN ('failed', 'expired', 'cancelled', 'skipped'))`;

const PROMOTE_SQL = `UPDATE actions SET deliverable_at = ?1
  WHERE status = 'queued' AND deliverable_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM actions earlier
    WHERE earlier.batch_id = actions.batch_id
      AND earlier.position < actions.position
      AND earlier.status <> 'done')`;

const iso = (ms: number) => new Date(ms).toISOString();

export function sweepStatements(
  db: D1Database,
  now: number,
): D1PreparedStatement[] {
  const at = iso(now);
  const cutoff = iso(now - ACTION_TTL_MS);
  return [
    db.prepare(EXPIRE_SQL).bind(at, cutoff),
    db
      .prepare(ABANDON_SQL)
      .bind(at, iso(now - ABANDON_MS), iso(now - COMPOSE_ABANDON_MS)),
    db.prepare(SKIP_SQL).bind(at),
    db.prepare(PROMOTE_SQL).bind(at),
  ];
}

export function createBatch(
  db: D1Database,
  input: {
    action: ActionVerb;
    mode: BatchMode;
    targets: ActionTarget[];
    requestedBy: string;
    now: number;
  },
) {
  const batchId = crypto.randomUUID();
  const at = iso(input.now);
  const actions = input.targets.map(({ signed: _, ...target }) => ({
    ...target,
    id: target.id ?? crypto.randomUUID(),
    status: "queued" as const,
  }));
  const rows = JSON.stringify(
    actions.map(({ id, nodeId, kind, name }, index) => ({
      id,
      nodeId,
      kind,
      name,
      signed: input.targets[index]?.signed ?? null,
    })),
  );
  const statement = db
    .prepare(
      `INSERT INTO actions (id, batch_id, position, mode, node_id, kind, name,
         action, status, requested_by, requested_at, deliverable_at, signed)
       SELECT json_extract(value, '$.id'), ?1, key, ?2,
              json_extract(value, '$.nodeId'), json_extract(value, '$.kind'),
              json_extract(value, '$.name'), ?3, 'queued', ?4, ?5,
              CASE WHEN ?2 = 'parallel' OR key = 0 THEN ?5 END,
              json_extract(value, '$.signed')
       FROM json_each(?6)`,
    )
    .bind(batchId, input.mode, input.action, input.requestedBy, at, rows);
  return { batchId, actions, statements: [statement] };
}

export async function deliverActions(
  db: D1Database,
  nodeId: string,
  now: number,
) {
  const rows = await db.prepare(DELIVER_SQL).bind(iso(now), nodeId).all<{
    id: string;
    kind: ActionKind;
    name: string;
    action: ActionVerb;
    deliverable_at: string;
    signed: string | null;
  }>();
  return rows.results.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    action: row.action,
    expiresAt: iso(Date.parse(row.deliverable_at) + ACTION_TTL_MS),
    ...(row.signed === null
      ? {}
      : { signed: JSON.parse(row.signed) as unknown }),
  }));
}

export async function heartbeatActions(
  db: D1Database,
  nodeId: string,
  now: number,
) {
  await db.batch(sweepStatements(db, now));
  return deliverActions(db, nodeId, now);
}

export function actionResultStatements(
  db: D1Database,
  nodeId: string,
  results: AgentActionResult[],
  now: number,
): D1PreparedStatement[] {
  return results.map((result) => {
    const reported = Date.parse(result.finishedAt);
    const finished = iso(
      Number.isFinite(reported) ? Math.min(reported, now) : now,
    );
    return db
      .prepare(
        `UPDATE actions SET status = ?, exit_code = ?, output = ?, finished_at = max(sent_at, ?)
         WHERE id = ? AND node_id = ? AND status = 'sent'`,
      )
      .bind(
        result.ok ? "done" : "failed",
        result.exitCode,
        result.output,
        finished,
        result.id,
        nodeId,
      );
  });
}

export function cancelStatement(
  db: D1Database,
  batchId: string,
  ownerId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE actions SET status = 'cancelled', finished_at = ?
       WHERE batch_id = ? AND status = 'queued'
         AND node_id IN (SELECT id FROM nodes WHERE owner_user_id = ?)`,
    )
    .bind(iso(now), batchId, ownerId);
}
