import { assertionSchema } from "@krynodes/protocol";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { createBatch, sweepStatements } from "../actions/store";
import { decodeJson } from "../lib/b64url";
import {
  invalidRequest,
  readJson,
  type KrynodesApp,
  type KrynodesEnv,
} from "./shared";

const b64url = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/u);

const deviceSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(1400)
    .regex(/^[A-Za-z0-9_-]+$/u),
  name: z.string().trim().min(1).max(40),
  alg: z.union([z.literal(-7), z.literal(-257)]),
  publicKey: b64url,
});

const changeSchema = z.object({
  v: z.literal(1),
  nodeIds: z.array(z.string().uuid()).min(1).max(100),
  version: z.number().int().positive(),
  keys: z
    .array(z.object({ id: z.string().min(1) }))
    .min(1)
    .max(20),
});

const trustSchema = z.union([
  z.strictObject({ changes: z.array(b64url).min(1).max(100) }),
  z.strictObject({ change: b64url, assertion: assertionSchema }),
]);

interface DeviceRow {
  id: string;
  name: string;
  alg: number;
  public_key: string;
  created_at: string;
  last_used_at: string | null;
}

function readChange(text: string) {
  const parsed = changeSchema.safeParse(decodeJson(text));
  return parsed.success ? parsed.data : null;
}

export async function activeDevices(db: D1Database, ownerId: string) {
  const rows = await db
    .prepare(
      `SELECT id, name, alg, public_key, created_at, last_used_at FROM devices
       WHERE owner_user_id = ? AND removed_at IS NULL ORDER BY created_at, id`,
    )
    .bind(ownerId)
    .all<DeviceRow>();
  return rows.results;
}

export function registerDeviceRoutes(
  app: KrynodesApp,
  requireOperator: MiddlewareHandler<KrynodesEnv>,
): void {
  app.get("/api/devices", requireOperator, async (context) => {
    const devices = await activeDevices(
      context.env.DB,
      context.get("identity").id,
    );
    return context.json({
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        alg: device.alg,
        publicKey: device.public_key,
        createdAt: device.created_at,
        lastUsedAt: device.last_used_at,
      })),
    });
  });

  app.post("/api/devices", requireOperator, async (context) => {
    const parsed = deviceSchema.safeParse(await readJson(context));
    if (!parsed.success) return invalidRequest(context);
    const device = parsed.data;
    try {
      await context.env.DB.prepare(
        `INSERT INTO devices (id, owner_user_id, name, alg, public_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          device.id,
          context.get("identity").id,
          device.name,
          device.alg,
          device.publicKey,
          new Date().toISOString(),
        )
        .run();
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      return context.json(
        {
          code: "DEVICE_EXISTS",
          message: "This device is already registered.",
        },
        409,
      );
    }
    return context.json({ id: device.id }, 201);
  });

  app.post("/api/trust", requireOperator, async (context) => {
    const parsed = trustSchema.safeParse(await readJson(context));
    if (!parsed.success) return invalidRequest(context);
    const db = context.env.DB;
    const identity = context.get("identity");
    const now = Date.now();
    const body = parsed.data;

    const first = "changes" in body;
    const changes = first
      ? body.changes.map((text) => ({ text, change: readChange(text) }))
      : [{ text: body.change, change: readChange(body.change) }];
    if (
      changes.some(
        ({ change }) => !change || (first && change.nodeIds.length !== 1),
      )
    ) {
      return invalidRequest(context);
    }
    const nodeIds = changes.flatMap(({ change }) => change!.nodeIds);
    if (new Set(nodeIds).size !== nodeIds.length) {
      return invalidRequest(context);
    }
    const nodes = await db
      .prepare(
        `SELECT id, trust_version FROM nodes
         WHERE owner_user_id = ? AND enrolled_at IS NOT NULL AND disabled_at IS NULL
           AND id IN (SELECT value FROM json_each(?))`,
      )
      .bind(identity.id, JSON.stringify(nodeIds))
      .all<{ id: string; trust_version: number | null }>();
    if (nodes.results.length !== nodeIds.length) {
      return context.json(
        { code: "NOT_FOUND", message: "A server was not found." },
        404,
      );
    }
    if (first && nodes.results.some((node) => (node.trust_version ?? 0) > 0)) {
      return context.json(
        {
          code: "TRUST_EXISTS",
          message:
            "A server already trusts devices. Change them with a trusted device.",
        },
        409,
      );
    }

    const targets = first
      ? changes.map(({ text, change }) => ({
          nodeId: change!.nodeIds[0]!,
          kind: "trust" as const,
          name: "devices",
          signed: { change: text, assertion: null },
        }))
      : nodeIds.map((nodeId) => ({
          nodeId,
          kind: "trust" as const,
          name: "devices",
          signed: { change: body.change, assertion: body.assertion },
        }));
    const batch = createBatch(db, {
      action: "trust",
      mode: "parallel",
      targets,
      requestedBy: identity.email,
      now,
    });
    const retire = first
      ? []
      : [
          db
            .prepare(
              `UPDATE devices SET removed_at = ?
               WHERE owner_user_id = ? AND removed_at IS NULL
                 AND id NOT IN (SELECT value FROM json_each(?))`,
            )
            .bind(
              new Date(now).toISOString(),
              identity.id,
              JSON.stringify(changes[0]!.change!.keys.map((key) => key.id)),
            ),
        ];
    await db.batch(sweepStatements(db, now));
    try {
      await db.batch([...batch.statements, ...retire]);
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      return context.json(
        {
          code: "ACTION_PENDING",
          message: "A device change is still on its way to a server.",
        },
        409,
      );
    }
    return context.json({ queued: targets.length }, 202);
  });
}
