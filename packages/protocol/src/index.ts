import { z } from "zod";

import { isValidTarget } from "./targets";

export { isProtectedTarget, isValidTarget } from "./targets";

export const agentHostSchema = z.object({
  hostname: z.string().min(1).max(255),
  operatingSystem: z.string().min(1).max(64),
  architecture: z.string().min(1).max(64),
  agentVersion: z.string().min(1).max(64),
});

export const metricSnapshotSchema = z.object({
  cpuPercent: z.number().min(0).max(100).nullable(),
  memoryUsedBytes: z.number().int().nonnegative().nullable(),
  memoryTotalBytes: z.number().int().nonnegative().nullable(),
  diskUsedBytes: z.number().int().nonnegative().nullable(),
  diskTotalBytes: z.number().int().nonnegative().nullable(),
  load1: z.number().nonnegative().nullable(),
  load5: z.number().nonnegative().nullable(),
  load15: z.number().nonnegative().nullable(),
  uptimeSeconds: z.number().int().nonnegative().nullable(),
});

export const checkResultSchema = z.object({
  checkId: z.string().uuid(),
  status: z.enum(["UP", "DOWN"]),
  latencyMs: z.number().int().nonnegative().nullable(),
  message: z.string().max(500).nullable(),
  checkedAt: z.string().datetime().optional(),
});

export const agentHeartbeatSchema = agentHostSchema.extend({
  nodeId: z.string().uuid(),
  metrics: metricSnapshotSchema,
  results: z.array(checkResultSchema).max(100).optional(),
});

export const enrollmentResponseSchema = z.object({
  nodeId: z.string().uuid(),
  token: z.string().min(1),
  intervalSeconds: z.number().int().positive(),
});

const serviceKindSchema = z.enum(["systemd", "docker"]);

export const SESSION_MS = 15 * 60_000;
export const COMMAND_GRACE_MS = 60 * 60_000;
export const TRUST_CHANGE_MS = 10 * 60_000;

const b64url = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const assertionSchema = z.strictObject({
  credentialId: b64url,
  authenticatorData: b64url,
  clientDataJSON: b64url,
  signature: b64url,
});

export const signedCommandSchema = z.strictObject({
  grant: assertionSchema.extend({ grant: b64url }),
  command: b64url,
  signature: b64url,
});

export const signedTrustSchema = z.strictObject({
  change: b64url,
  assertion: assertionSchema.nullable(),
});

export const agentActionSchema = z
  .strictObject({
    id: z.string().uuid(),
    kind: z.enum(["systemd", "docker", "compose", "trust"]),
    name: z.string(),
    action: z.enum(["start", "stop", "restart", "deploy", "rollback", "trust"]),
    expiresAt: z.string().datetime(),
    signed: z.union([signedCommandSchema, signedTrustSchema]).optional(),
  })
  .refine((action) => isValidTarget(action.kind, action.name))
  .refine((action) => {
    if (action.kind === "trust") {
      return (
        action.action === "trust" &&
        signedTrustSchema.safeParse(action.signed).success
      );
    }
    const allowed =
      action.kind === "compose"
        ? ["deploy", "rollback"]
        : ["start", "stop", "restart"];
    return (
      allowed.includes(action.action) &&
      signedCommandSchema.safeParse(action.signed).success
    );
  });

export const heartbeatResponseSchema = z.object({
  ok: z.literal(true),
  intervalSeconds: z.number().int().positive(),
  configVersion: z.string().min(1),
  update: z
    .object({
      version: z.string().regex(/^\d+\.\d+\.\d+$/u),
      requestedAt: z.string().min(1),
    })
    .optional(),
  actions: z.array(agentActionSchema).max(10).optional(),
  refresh: z.literal(true).optional(),
});

export const serviceEntrySchema = z
  .strictObject({
    kind: serviceKindSchema,
    name: z.string(),
    state: z.enum(["running", "stopped", "failed", "starting"]),
    since: z.string().datetime().nullable(),
    system: z.boolean(),
  })
  .refine((entry) => isValidTarget(entry.kind, entry.name));

export const stackEntrySchema = z
  .strictObject({
    project: z.string(),
    directory: z.string().min(1).max(4096).startsWith("/"),
    running: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    compose: z.boolean(),
    rollback: z.boolean(),
  })
  .refine((stack) => isValidTarget("compose", stack.project));

export const trustReportSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  keys: z.array(z.string().regex(/^[0-9a-f]{16}$/u)).max(20),
});

export const actionResultSchema = z.strictObject({
  id: z.string().uuid(),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  output: z.string().max(2048),
  finishedAt: z.string().datetime(),
});

export const agentActionsRequestSchema = z
  .strictObject({
    nodeId: z.string().uuid(),
    results: z.array(actionResultSchema).max(10).optional(),
    inventory: z
      .strictObject({
        hash: z.string().regex(/^[0-9a-f]{64}$/u),
        services: z.array(serviceEntrySchema).max(500).optional(),
        stacks: z.array(stackEntrySchema).max(50).optional(),
        trust: trustReportSchema.optional(),
      })
      .optional(),
  })
  .refine(
    (request) =>
      request.results !== undefined || request.inventory !== undefined,
  );

export const agentActionsResponseSchema = z.object({
  ok: z.literal(true),
  inventoryHash: z.string().nullable(),
});

export const agentCheckSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  kind: z.enum(["HTTP", "TCP", "SERVICE"]),
  target: z.string().min(1),
  timeoutSeconds: z.number().int().positive(),
});

export const agentConfigResponseSchema = z.object({
  nodeId: z.string().uuid(),
  intervalSeconds: z.number().int().positive(),
  checks: z.array(agentCheckSchema),
  configVersion: z.string().min(1),
});

export type AgentHost = z.infer<typeof agentHostSchema>;
export type MetricSnapshot = z.infer<typeof metricSnapshotSchema>;
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type EnrollmentResponse = z.infer<typeof enrollmentResponseSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
export type AgentCheck = z.infer<typeof agentCheckSchema>;
export type AgentConfigResponse = z.infer<typeof agentConfigResponseSchema>;
export type AgentActionResult = z.infer<typeof actionResultSchema>;
export type ServiceEntry = z.infer<typeof serviceEntrySchema>;
export type AgentActionsRequest = z.infer<typeof agentActionsRequestSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type SignedCommand = z.infer<typeof signedCommandSchema>;
export type SignedTrust = z.infer<typeof signedTrustSchema>;
export type StackEntry = z.infer<typeof stackEntrySchema>;
export type TrustReport = z.infer<typeof trustReportSchema>;
