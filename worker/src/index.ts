import { runReleaseCheck } from "./agent/releases";
import { app } from "./app";
import type { Env } from "./env";

const worker = {
  fetch(request: Request, env: Env, context: ExecutionContext) {
    return app.fetch(request, env, context);
  },
  scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): void {
    context.waitUntil(runRetention(env));
    context.waitUntil(runReleaseCheck(env.DB));
  },
};

export async function runRetention(env: Env): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM node_metrics WHERE datetime(recorded_at) < datetime('now', '-8 days')",
  ).run();
  await env.DB.prepare(
    "DELETE FROM check_results WHERE datetime(checked_at) < datetime('now', '-8 days')",
  ).run();
  await env.DB.prepare(
    `DELETE FROM incidents
     WHERE status = 'RESOLVED'
       AND datetime(resolved_at) < datetime('now', '-180 days')`,
  ).run();
  await env.DB.prepare(
    "DELETE FROM enrollment_tokens WHERE datetime(expires_at) < datetime('now', '-1 day')",
  ).run();
  await env.DB.prepare(
    "DELETE FROM actions WHERE datetime(requested_at) < datetime('now', '-90 days')",
  ).run();
}

export default worker;
