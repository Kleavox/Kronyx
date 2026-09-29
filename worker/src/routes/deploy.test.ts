import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "44444444-4444-4444-8444-444444444444";
const ACTION = "55555555-5555-4555-8555-555555555555";
const NOW = new Date().toISOString();
const LATER = new Date(Date.now() + 600_000).toISOString();

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const assertion = {
  credentialId: "ZGV2aWNlLTE",
  authenticatorData: "YXV0aA",
  clientDataJSON: "Y2xpZW50",
  signature: "c2ln",
};

interface Reply {
  code?: string;
  queued?: number;
  devices?: { id: string; name: string }[];
  nodes?: {
    id: string;
    stacks: Record<string, unknown>[];
    trust: { version: number; keys: string[] } | null;
  }[];
  command?: string;
}

const reply = async (response: Response | Promise<Response>) =>
  (await (await response).json()) as Reply;

function setup() {
  const { db, sqlite } = createTestDb();
  for (const [id, owner] of [
    [A, undefined],
    [B, undefined],
    [FOREIGN, "someone-else"],
  ] as const) {
    seedNode(sqlite, { id, owner });
    sqlite
      .prepare(
        "UPDATE nodes SET agent_version = '0.2.0', last_seen_at = datetime('now') WHERE id = ?",
      )
      .run(id);
  }
  sqlite
    .prepare(
      "INSERT INTO stacks (node_id, project, directory, running, total, compose, rollback, updated_at) VALUES (?, 'listmonk', '/opt/listmonk', 5, 5, 1, 0, ?)",
    )
    .run(A, NOW);
  const env = {
    DB: db,
    PUBLIC_ORIGIN: "https://kry.example.test",
  } as unknown as Env;
  const call = (method: string, path: string, body?: unknown) =>
    app.request(
      `https://kry.example.test${path}`,
      {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  const device = (id = "ZGV2aWNlLTE", name = "Laptop") =>
    call("POST", "/api/devices", {
      id,
      name,
      alg: -7,
      publicKey: "TUZrd0V3WUhLb1pJemowQ0FRWUlLb1pJemowREFRY0RRZ0FF",
    });
  const change = (nodeIds: string[], version = 1, keys = ["ZGV2aWNlLTE"]) =>
    b64({
      v: 1,
      nodeIds,
      origin: "https://kry.example.test",
      rpId: "kry.example.test",
      version,
      keys: keys.map((id) => ({
        id,
        name: "Laptop",
        alg: -7,
        publicKey: "TUZrd0V3WUhLb1pJemowQ0FRWUlLb1pJemowREFRY0RRZ0FF",
      })),
      issuedAt: NOW,
      expiresAt: LATER,
    });
  const command = (overrides: Record<string, unknown> = {}) => ({
    grant: { grant: "Z3JhbnQ", ...assertion },
    command: b64({
      v: 1,
      id: ACTION,
      nodeId: A,
      kind: "compose",
      name: "listmonk",
      action: "deploy",
      issuedAt: NOW,
      expiresAt: LATER,
      ...overrides,
    }),
    signature: "c2lnbmF0dXJl",
  });
  const deploy = (
    action: string,
    signed: unknown,
    target: Record<string, unknown> = {},
  ) =>
    call("POST", "/api/actions", {
      action,
      targets: [
        {
          id: ACTION,
          nodeId: A,
          kind: "compose",
          name: "listmonk",
          ...(signed === undefined ? {} : { signed }),
          ...target,
        },
      ],
    });
  return { sqlite, env, call, device, change, command, deploy };
}

describe("deploy devices", () => {
  it("registers a device once and lists it", async () => {
    const { call, device } = setup();
    expect((await device()).status).toBe(201);
    expect((await device()).status).toBe(409);
    expect(
      (
        await call("POST", "/api/devices", {
          id: "eA",
          name: "Weird",
          alg: -8,
          publicKey: "TUZr",
        })
      ).status,
    ).toBe(400);
    expect((await reply(call("GET", "/api/devices"))).devices).toEqual([
      expect.objectContaining({ id: "ZGV2aWNlLTE", name: "Laptop", alg: -7 }),
    ]);
  });
});

describe("POST /api/trust", () => {
  it("queues the first trust only to servers that trust nothing yet", async () => {
    const { sqlite, call, change } = setup();
    sqlite.prepare("UPDATE nodes SET trust_version = 1 WHERE id = ?").run(B);
    const first = await call("POST", "/api/trust", { changes: [change([A])] });
    expect(first.status).toBe(202);
    expect(await reply(first)).toEqual({ queued: 1 });
    const row = sqlite
      .prepare(
        "SELECT kind, name, action, mode, signed FROM actions WHERE node_id = ?",
      )
      .get(A) as { signed: string };
    expect(row).toMatchObject({
      kind: "trust",
      name: "devices",
      action: "trust",
      mode: "parallel",
    });
    expect(JSON.parse(row.signed)).toEqual({
      change: change([A]),
      assertion: null,
    });
    const trusted = await call("POST", "/api/trust", {
      changes: [change([B])],
    });
    expect(trusted.status).toBe(409);
    expect((await reply(trusted)).code).toBe("TRUST_EXISTS");
    expect(
      (await call("POST", "/api/trust", { changes: [change([A, B])] })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/trust", { changes: [change([FOREIGN])] }))
        .status,
    ).toBe(404);
  });

  it("queues a signed change to every listed server and retires removed devices", async () => {
    const { sqlite, call, device, change } = setup();
    await device("ZGV2aWNlLTE", "Laptop");
    await device("ZGV2aWNlLTI", "Phone");
    const signed = { change: change([A, B], 2), assertion };
    const response = await call("POST", "/api/trust", signed);
    expect(response.status).toBe(202);
    expect(await reply(response)).toEqual({ queued: 2 });
    expect(
      sqlite
        .prepare(
          "SELECT node_id, signed FROM actions WHERE kind = 'trust' ORDER BY node_id",
        )
        .all()
        .map((row) => JSON.parse((row as { signed: string }).signed)),
    ).toEqual([signed, signed]);
    expect(
      sqlite.prepare("SELECT id FROM devices WHERE removed_at IS NULL").all(),
    ).toEqual([{ id: "ZGV2aWNlLTE" }]);
    expect(
      (
        await call("POST", "/api/trust", {
          change: change([FOREIGN], 2),
          assertion,
        })
      ).status,
    ).toBe(404);
  });
});

describe("compose actions", () => {
  it("queues a signed deploy under the browser's id", async () => {
    const { sqlite, device, command, deploy } = setup();
    await device();
    const response = await deploy("deploy", command());
    expect(response.status).toBe(201);
    expect(
      sqlite
        .prepare("SELECT id, kind, name, action, status FROM actions")
        .get(),
    ).toEqual({
      id: ACTION,
      kind: "compose",
      name: "listmonk",
      action: "deploy",
      status: "queued",
    });
    expect(
      sqlite
        .prepare("SELECT last_used_at IS NOT NULL AS used FROM devices")
        .get(),
    ).toEqual({ used: 1 });
  });

  it("refuses a deploy whose signed command names something else", async () => {
    const { command, deploy } = setup();
    const mismatch = await deploy("deploy", command({ action: "rollback" }));
    expect(mismatch.status).toBe(400);
    expect((await reply(mismatch)).code).toBe("SIGNATURE_MISMATCH");
    expect((await deploy("deploy", command({ nodeId: B }))).status).toBe(400);
  });

  it("refuses an unsigned deploy, a signed restart and mixed kinds", async () => {
    const { call, command, deploy } = setup();
    expect((await deploy("deploy", undefined)).status).toBe(400);
    expect(
      (
        await call("POST", "/api/actions", {
          action: "restart",
          targets: [
            { nodeId: A, kind: "docker", name: "adguard", signed: command() },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (await deploy("restart", command({ action: "restart" }))).status,
    ).toBe(400);
  });

  it("refuses a missing stack and a rollback with nothing kept", async () => {
    const { command, deploy } = setup();
    const missing = await deploy("deploy", command({ name: "shop" }), {
      name: "shop",
    });
    expect(missing.status).toBe(422);
    expect((await reply(missing)).code).toBe("UNKNOWN_TARGET");
    const rollback = await deploy("rollback", command({ action: "rollback" }));
    expect(rollback.status).toBe(422);
  });

  it("lists stacks and trust with the services", async () => {
    const { sqlite, call } = setup();
    sqlite
      .prepare(
        "UPDATE nodes SET trust_version = 2, trust_keys = ? WHERE id = ?",
      )
      .run('["0123456789abcdef"]', A);
    const body = await reply(call("GET", "/api/services"));
    const a = body.nodes!.find((node) => node.id === A)!;
    expect(a.stacks).toEqual([
      {
        project: "listmonk",
        directory: "/opt/listmonk",
        running: 5,
        total: 5,
        compose: true,
        rollback: false,
      },
    ]);
    expect(a.trust).toEqual({ version: 2, keys: ["0123456789abcdef"] });
    expect(body.nodes!.find((node) => node.id === B)!.trust).toBeNull();
  });
});

describe("enroll command", () => {
  it("carries the deploy devices when there are some", async () => {
    const { call, device } = setup();
    expect(
      (await reply(call("POST", "/api/enrollments"))).command,
    ).not.toContain("--trust");
    await device();
    expect((await reply(call("POST", "/api/enrollments"))).command).toMatch(
      / --trust https:\/\/kry\.example\.test ZGV2aWNlLTE\.-7\.TUZrd0V3WUhLb1pJemowQ0FRWUlLb1pJemowREFRY0RRZ0FF$/u,
    );
  });
});
