import type { MiddlewareHandler } from "hono";

import { hubFor, streamsOn } from "../fleet/client";
import type { KrynodesApp, KrynodesEnv } from "./shared";

export function registerLiveRoutes(
  app: KrynodesApp,
  requireOperator: MiddlewareHandler<KrynodesEnv>,
): void {
  app.get("/api/live", requireOperator, async (context) => {
    if (!streamsOn(context.env)) {
      return context.json({ code: "LIVE_OFF" }, 404);
    }
    if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return context.json({ code: "UPGRADE_REQUIRED" }, 426);
    }
    const headers = new Headers();
    for (const [name, value] of context.req.raw.headers) {
      const key = name.toLowerCase();
      if (
        key === "authorization" ||
        key === "cookie" ||
        key.startsWith("cf-access") ||
        key.startsWith("x-kry-")
      ) {
        continue;
      }
      headers.set(name, value);
    }
    return hubFor(context.env, context.get("identity").id).fetch(
      new Request("https://fleet/watch", { headers }),
    );
  });
}
