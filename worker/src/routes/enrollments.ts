import type { MiddlewareHandler } from "hono";

import type { Env } from "../env";
import { randomToken, sha256 } from "../lib/crypto";
import { loadFleet, type Fleet } from "../trust/fleet";
import { confirmed } from "../trust/intent";
import { agentOrigin, type KrynodesApp, type KrynodesEnv } from "./shared";

const ENROLLMENT_TTL_MS = 30 * 60_000;

function installCommand(env: Env, token: string, fleet: Fleet): string {
  const endpoint = agentOrigin(env);
  const core = fleet.devices.filter((device) => fleet.core.includes(device.id));
  const passphrase = fleet.passphrase
    ? ` --passphrase ${fleet.passphrase.salt}.${fleet.passphrase.iterations}.${fleet.passphrase.publicKey}`
    : "";
  const grant = core.length < 2 ? " --grant" : "";
  const trust =
    core.length > 0
      ? ` --trust ${env.PUBLIC_ORIGIN}${passphrase}${grant} -- ${core
          .map((device) => `${device.id}.${device.alg}.${device.publicKey}`)
          .join(" ")}`
      : "";
  return `curl -fsSL ${endpoint}/install.sh | sudo sh -s -- ${endpoint} ${token}${trust}`;
}

export function registerEnrollmentRoutes(
  app: KrynodesApp,
  requireOperator: MiddlewareHandler<KrynodesEnv>,
): void {
  app.post("/api/enrollments", requireOperator, async (context) => {
    const fleet = await loadFleet(context.env.DB, context.get("identity").id);
    const refused = await confirmed(context, "enrollment.create", "new", fleet);
    if (refused) return refused;
    const id = crypto.randomUUID();
    const token = randomToken();
    const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString();
    await context.env.DB.prepare(
      `INSERT INTO enrollment_tokens (id, owner_user_id, token_hash, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(id, context.get("identity").id, await sha256(token), expiresAt)
      .run();
    return context.json(
      {
        id,
        enrollmentToken: token,
        enrollmentExpiresAt: expiresAt,
        command: installCommand(context.env, token, fleet),
      },
      201,
    );
  });

  app.get("/api/enrollments/:id", requireOperator, async (context) => {
    const row = await context.env.DB.prepare(
      `SELECT e.expires_at, e.used_at, n.id AS node_id, n.name AS node_name
       FROM enrollment_tokens e
       LEFT JOIN nodes n ON n.id = e.node_id
       WHERE e.id = ? AND e.owner_user_id = ?`,
    )
      .bind(context.req.param("id"), context.get("identity").id)
      .first<{
        expires_at: string;
        used_at: string | null;
        node_id: string | null;
        node_name: string | null;
      }>();
    if (!row) return context.json({ code: "NOT_FOUND" }, 404);
    if (row.used_at) {
      return context.json({
        status: "used",
        node: row.node_id ? { id: row.node_id, name: row.node_name } : null,
      });
    }
    return context.json({
      status: Date.parse(row.expires_at) > Date.now() ? "pending" : "expired",
    });
  });
}
