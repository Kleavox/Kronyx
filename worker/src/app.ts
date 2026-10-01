import { Hono } from "hono";

import { securityHeaders } from "./lib/security-headers";
import {
  requireGuardInProduction,
  requireOperator,
  resolveSession,
} from "./lib/session";
import { registerAdminRoutes } from "./routes/admin";
import { registerAgentRoutes } from "./routes/agent";
import { registerAgentUpdateRoutes } from "./routes/agent-updates";
import { registerDeviceRoutes } from "./routes/devices";
import { registerProposalRoutes } from "./routes/proposals";
import { registerCheckResultRoutes } from "./routes/check-results";
import { registerEnrollmentRoutes } from "./routes/enrollments";
import { registerMetricRoutes } from "./routes/metrics";
import { registerServiceRoutes } from "./routes/services";
import { registerUsageRoutes } from "./usage/usage";
import type { KrynodesEnv } from "./routes/shared";

const app = new Hono<KrynodesEnv>();

app.onError((error, context) => {
  console.error("[kry]", error);
  return context.json(
    {
      code: "INTERNAL_ERROR",
      message: "Krynodes could not complete the request.",
    },
    500,
  );
});

app.use("*", securityHeaders({ referrerPolicy: "same-origin" }));

app.use("*", async (context, next) => {
  requireGuardInProduction(context.env);
  await next();
});

app.get("/health", (context) => context.json({ service: "kry", status: "ok" }));

app.get("/api/session", async (context) => {
  const { via, identity } = await resolveSession(context.req.raw, context.env);
  return identity
    ? context.json({ authenticated: true, via, identity })
    : context.json({ authenticated: false, via });
});

registerAdminRoutes(app, requireOperator);
registerMetricRoutes(app, requireOperator);
registerCheckResultRoutes(app, requireOperator);
registerEnrollmentRoutes(app, requireOperator);
registerAgentUpdateRoutes(app, requireOperator);
registerServiceRoutes(app, requireOperator);
registerDeviceRoutes(app, requireOperator);
registerProposalRoutes(app, requireOperator);
registerUsageRoutes(app, requireOperator);
registerAgentRoutes(app);

app.all("/api/*", (context) =>
  context.json({ code: "NOT_FOUND", message: "No such endpoint." }, 404),
);

app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

export { app };
