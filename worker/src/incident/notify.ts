import type { Env } from "../env";
import { sendIncidentEmail } from "../lib/mail";

interface IncidentNotification {
  nodeId: string;
  checkName: string;
  kind: "opened" | "resolved";
  summary: string;
  occurredAt: string;
}

export type IncidentNotifier = (
  notification: IncidentNotification,
) => Promise<void>;

export function createIncidentNotifier(env: Env): IncidentNotifier {
  return async (notification) => {
    try {
      const node = await env.DB.prepare(`SELECT name FROM nodes WHERE id = ?`)
        .bind(notification.nodeId)
        .first<{ name: string }>();
      if (!node) return;

      await sendIncidentEmail(env, {
        kind: notification.kind,
        checkName: notification.checkName,
        nodeName: node.name,
        summary: notification.summary,
        occurredAt: notification.occurredAt,
      });
    } catch (error) {
      console.error("[kry notify]", error);
    }
  };
}
