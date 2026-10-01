import type { Context } from "hono";

const KEY = "agent_http";

export async function agentHttpOn(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(KEY)
    .first<{ value: string | null }>();
  return row?.value !== "off";
}

export function setAgentHttp(db: D1Database, enabled: boolean) {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(KEY, enabled ? "on" : "off", new Date().toISOString())
    .run();
}

export const agentHttpGone = (context: Context) =>
  context.json(
    {
      code: "AGENT_UPDATE_REQUIRED",
      message:
        "This agent reports over HTTP, which is turned off. Update it to 0.3.1 or later.",
    },
    410,
  );
