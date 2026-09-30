import { describe, expect, it } from "vitest";

import fixture from "./fixtures/agent-config.json";
import targets from "./fixtures/targets.json";
import {
  agentActionSchema,
  agentActionsRequestSchema,
  agentActionsResponseSchema,
  agentConfigResponseSchema,
  agentHeartbeatSchema,
  heartbeatResponseSchema,
  isProtectedTarget,
  COMMAND_GRACE_MS,
  SESSION_MS,
  TRUST_CHANGE_MS,
  isValidTarget,
} from "./index";

describe("Krynodes Agent protocol v1", () => {
  it("validates the shared Agent configuration fixture", () => {
    expect(
      agentConfigResponseSchema.parse(fixture).checks[0]?.timeoutSeconds,
    ).toBe(10);
  });

  it("rejects database-shaped timeout fields", () => {
    const result = agentConfigResponseSchema.safeParse({
      ...fixture,
      checks: [
        {
          ...fixture.checks[0],
          timeoutSeconds: undefined,
          timeout_seconds: 10,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("carries a config version in the shared fixture", () => {
    expect(agentConfigResponseSchema.parse(fixture).configVersion).toBe(
      "0123456789abcdef",
    );
  });

  it("accepts a heartbeat carrying check results, and one without, but no unknown status", () => {
    const heartbeat = {
      nodeId: fixture.nodeId,
      hostname: "pivox",
      operatingSystem: "linux",
      architecture: "arm64",
      agentVersion: "0.3.0",
      metrics: {
        cpuPercent: 1,
        memoryUsedBytes: 1,
        memoryTotalBytes: 2,
        diskUsedBytes: 1,
        diskTotalBytes: 2,
        load1: 0,
        load5: 0,
        load15: 0,
        uptimeSeconds: 1,
      },
    };
    expect(agentHeartbeatSchema.parse(heartbeat).results).toBeUndefined();
    expect(
      agentHeartbeatSchema.parse({
        ...heartbeat,
        results: [
          {
            checkId: fixture.checks[0]?.id,
            status: "UP",
            latencyMs: 12,
            message: null,
          },
        ],
      }).results,
    ).toHaveLength(1);
    expect(
      agentHeartbeatSchema.safeParse({
        ...heartbeat,
        results: [
          {
            checkId: fixture.checks[0]?.id,
            status: "UNKNOWN",
            latencyMs: null,
            message: null,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a heartbeat from a legacy node with more than 20 checks", () => {
    const results = Array.from({ length: 21 }, () => ({
      checkId: fixture.checks[0]?.id,
      status: "UP",
      latencyMs: 1,
      message: null,
    }));
    expect(
      agentHeartbeatSchema.safeParse({
        nodeId: fixture.nodeId,
        hostname: "legacy",
        operatingSystem: "linux",
        architecture: "amd64",
        agentVersion: "0.3.0",
        metrics: {
          cpuPercent: null,
          memoryUsedBytes: null,
          memoryTotalBytes: null,
          diskUsedBytes: null,
          diskTotalBytes: null,
          load1: null,
          load5: null,
          load15: null,
          uptimeSeconds: null,
        },
        results,
      }).success,
    ).toBe(true);
  });

  it("requires a config version in the heartbeat response", () => {
    expect(
      heartbeatResponseSchema.safeParse({ ok: true, intervalSeconds: 60 })
        .success,
    ).toBe(false);
  });

  it("carries an update instruction only with a strict version", () => {
    const base = { ok: true, intervalSeconds: 60, configVersion: "v1" };
    const parsed = heartbeatResponseSchema.parse({
      ...base,
      update: { version: "0.5.2", requestedAt: "2026-09-28T08:00:00.000Z" },
    });
    expect(parsed.update).toEqual({
      version: "0.5.2",
      requestedAt: "2026-09-28T08:00:00.000Z",
    });
    expect(
      heartbeatResponseSchema.safeParse({
        ...base,
        update: { version: "../evil", requestedAt: "x" },
      }).success,
    ).toBe(false);
  });
});

const pairs = (list: string[][]) =>
  list.map(([kind = "", name = ""]) => ({ kind, name }));

describe("service targets", () => {
  it("protects what keeps a server reachable, and Krynodes itself", () => {
    for (const { kind, name } of pairs(targets.protected)) {
      expect(isValidTarget(kind, name), name).toBe(true);
      expect(isProtectedTarget(kind, name), name).toBe(true);
    }
  });

  it("lets every other well-formed service through", () => {
    for (const { kind, name } of pairs(targets.allowed)) {
      expect(isValidTarget(kind, name), name).toBe(true);
      expect(isProtectedTarget(kind, name), name).toBe(false);
    }
  });

  it("refuses names that could be read as options, paths or other kinds", () => {
    for (const { kind, name } of pairs(targets.invalid)) {
      expect(isValidTarget(kind, name), JSON.stringify(name)).toBe(false);
    }
  });

  it("stops names at 128 characters", () => {
    expect(isValidTarget("docker", "a".repeat(128))).toBe(true);
    expect(isValidTarget("docker", "a".repeat(129))).toBe(false);
  });
});

const assertion = {
  credentialId: "Y3JlZA",
  authenticatorData: "YXV0aA",
  clientDataJSON: "Y2xpZW50",
  signature: "c2ln",
};
const signedCommand = {
  grant: { grant: "Z3JhbnQ", ...assertion },
  command: "Y29tbWFuZA",
  signature: "c2lnbmF0dXJl",
};

describe("service action messages", () => {
  const id = "0b4f4f53-7d1c-4b55-9a39-2f0a0d6c1a01";
  const action = {
    id,
    kind: "docker",
    name: "adguard",
    action: "restart",
    expiresAt: "2026-09-29T10:10:00.000Z",
    signed: signedCommand,
  };

  it("carries a start, stop or restart only with a signed command", () => {
    expect(agentActionSchema.safeParse(action).success).toBe(true);
    const { signed: _, ...unsigned } = action;
    expect(agentActionSchema.safeParse(unsigned).success).toBe(false);
    expect(
      agentActionSchema.safeParse({
        ...action,
        signed: { change: "Y2hhbmdl", assertion },
      }).success,
    ).toBe(false);
  });

  it("carries actions and a refresh in the heartbeat response", () => {
    const parsed = heartbeatResponseSchema.parse({
      ok: true,
      intervalSeconds: 60,
      configVersion: "v1",
      actions: [action],
      refresh: true,
    });
    expect(parsed.actions).toEqual([action]);
    expect(parsed.refresh).toBe(true);
    expect(
      heartbeatResponseSchema.safeParse({
        ok: true,
        intervalSeconds: 60,
        configVersion: "v1",
        actions: [{ ...action, name: "a;b" }],
      }).success,
    ).toBe(false);
    expect(
      heartbeatResponseSchema.safeParse({
        ok: true,
        intervalSeconds: 60,
        configVersion: "v1",
        actions: [{ ...action, action: "exec" }],
      }).success,
    ).toBe(false);
  });

  it("accepts results, an inventory, or both, and nothing else", () => {
    const nodeId = "11111111-1111-4111-8111-111111111111";
    const result = {
      id,
      ok: false,
      exitCode: 1,
      output: "Job failed",
      finishedAt: "2026-09-29T10:01:05.000Z",
    };
    const inventory = {
      hash: "a".repeat(64),
      services: [
        {
          kind: "systemd",
          name: "nginx.service",
          state: "running",
          since: null,
          system: false,
        },
      ],
    };
    expect(
      agentActionsRequestSchema.safeParse({ nodeId, results: [result] })
        .success,
    ).toBe(true);
    expect(
      agentActionsRequestSchema.safeParse({ nodeId, inventory }).success,
    ).toBe(true);
    expect(
      agentActionsRequestSchema.safeParse({
        nodeId,
        inventory: { hash: "a".repeat(64) },
      }).success,
    ).toBe(true);
    expect(agentActionsRequestSchema.safeParse({ nodeId }).success).toBe(false);
    expect(
      agentActionsRequestSchema.safeParse({
        nodeId,
        results: [{ ...result, output: "x".repeat(2049) }],
      }).success,
    ).toBe(false);
    expect(
      agentActionsRequestSchema.safeParse({
        nodeId,
        inventory: { hash: "not-a-hash" },
      }).success,
    ).toBe(false);
    expect(
      agentActionsRequestSchema.safeParse({
        nodeId,
        inventory: {
          hash: "a".repeat(64),
          services: Array.from({ length: 501 }, (_, index) => ({
            kind: "docker",
            name: `c${index}`,
            state: "running",
            since: null,
            system: false,
          })),
        },
      }).success,
    ).toBe(false);
    expect(
      agentActionsRequestSchema.safeParse({
        nodeId,
        results: Array.from({ length: 11 }, () => result),
      }).success,
    ).toBe(false);
    expect(
      agentActionsResponseSchema.parse({ ok: true, inventoryHash: null }),
    ).toEqual({ ok: true, inventoryHash: null });
  });
});

describe("strict action messages", () => {
  const nodeId = "11111111-1111-4111-8111-111111111111";
  const id = "0b4f4f53-7d1c-4b55-9a39-2f0a0d6c1a01";

  it("refuses unknown keys in results, inventories and actions", () => {
    const result = {
      id,
      ok: true,
      exitCode: 0,
      output: "",
      finishedAt: "2026-09-29T10:01:05.000Z",
    };
    expect(
      agentActionsRequestSchema.safeParse({
        nodeId,
        results: [{ ...result, shell: "rm -rf /" }],
      }).success,
    ).toBe(false);
    expect(
      agentActionsRequestSchema.safeParse({
        nodeId,
        inventory: { hash: "a".repeat(64), extra: true },
      }).success,
    ).toBe(false);
    expect(
      agentActionsRequestSchema.safeParse({
        nodeId,
        results: [result],
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      heartbeatResponseSchema.safeParse({
        ok: true,
        intervalSeconds: 60,
        configVersion: "v1",
        actions: [
          {
            id,
            kind: "docker",
            name: "adguard",
            action: "restart",
            expiresAt: "2026-09-29T10:10:00.000Z",
            command: "x",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("deploy messages", () => {
  const id = "0b4f4f53-7d1c-4b55-9a39-2f0a0d6c1a02";
  const deploy = {
    id,
    kind: "compose",
    name: "listmonk",
    action: "deploy",
    expiresAt: "2026-09-29T10:10:00.000Z",
    signed: signedCommand,
  };
  const inventory = (extra: Record<string, unknown>) => ({
    nodeId: "0b4f4f53-7d1c-4b55-9a39-2f0a0d6c1a03",
    inventory: { hash: "a".repeat(64), ...extra },
  });

  it("accepts a signed compose deploy and refuses it unsigned or with a service action", () => {
    expect(agentActionSchema.safeParse(deploy).success).toBe(true);
    expect(
      agentActionSchema.safeParse({ ...deploy, action: "rollback" }).success,
    ).toBe(true);
    const { signed: _, ...unsigned } = deploy;
    expect(agentActionSchema.safeParse(unsigned).success).toBe(false);
    expect(
      agentActionSchema.safeParse({ ...deploy, action: "restart" }).success,
    ).toBe(false);
    expect(
      agentActionSchema.safeParse({
        ...deploy,
        kind: "docker",
        name: "adguard",
        action: "deploy",
      }).success,
    ).toBe(false);
    expect(
      agentActionSchema.safeParse({
        ...deploy,
        signed: { ...signedCommand, extra: 1 },
      }).success,
    ).toBe(false);
  });

  it("accepts a trust action with or without an assertion", () => {
    const trust = {
      id,
      kind: "trust",
      name: "devices",
      action: "trust",
      expiresAt: "2026-09-29T10:10:00.000Z",
      signed: { change: "Y2hhbmdl", assertion },
    };
    expect(agentActionSchema.safeParse(trust).success).toBe(true);
    expect(
      agentActionSchema.safeParse({
        ...trust,
        signed: { change: "Y2hhbmdl", assertion: null },
      }).success,
    ).toBe(true);
    expect(
      agentActionSchema.safeParse({ ...trust, signed: signedCommand }).success,
    ).toBe(false);
  });

  it("accepts stacks and trust in the inventory and refuses a relative directory", () => {
    const stack = {
      project: "listmonk",
      directory: "/opt/listmonk",
      running: 5,
      total: 5,
      compose: true,
      rollback: false,
    };
    const trust = { version: 2, keys: ["0123456789abcdef"] };
    expect(
      agentActionsRequestSchema.safeParse(inventory({ stacks: [stack], trust }))
        .success,
    ).toBe(true);
    expect(
      agentActionsRequestSchema.safeParse(
        inventory({ stacks: [{ ...stack, directory: "opt/listmonk" }] }),
      ).success,
    ).toBe(false);
    expect(
      agentActionsRequestSchema.safeParse(
        inventory({ trust: { version: 1, keys: ["xyz"] } }),
      ).success,
    ).toBe(false);
  });

  it("names the session limits", () => {
    expect(SESSION_MS).toBe(15 * 60_000);
    expect(COMMAND_GRACE_MS).toBe(60 * 60_000);
    expect(TRUST_CHANGE_MS).toBe(10 * 60_000);
  });
});
