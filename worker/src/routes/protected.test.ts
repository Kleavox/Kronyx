import { describe, expect, it } from "vitest";

import { app } from "../app";
import type { Env } from "../env";
import { toB64url } from "../lib/b64url";
import { fingerprint } from "../lib/webauthn";
import { testPasskey, type TestPasskey } from "../test/passkeys";
import { seedCheck, seedNode } from "../test/seed";
import { createTestDb } from "../test/sqlite-d1";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CHECK = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "https://kry.example.test";
const RP = "kry.example.test";

const encoder = new TextEncoder();
const json = (value: unknown) =>
  new Uint8Array(encoder.encode(JSON.stringify(value)));
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

async function proof(
  passkey: TestPasskey,
  op: string,
  target: string,
  options: { verified?: boolean; at?: number } = {},
) {
  const now = Date.now();
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
  const grant = json({
    v: 1,
    rpId: RP,
    sessionKey: toB64url(spki),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    nonce: "n",
  });
  const intent = json({
    v: 1,
    op,
    target,
    at: new Date(options.at ?? now).toISOString(),
    origin: ORIGIN,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      intent,
    ),
  );
  return toB64url(
    json({
      grant: {
        grant: toB64url(grant),
        ...(await passkey.sign({
          challenge: await sha256(grant),
          origin: ORIGIN,
          rpId: RP,
          verified: options.verified ?? true,
        })),
      },
      command: toB64url(intent),
      signature: toB64url(signature),
    }),
  );
}

async function setup(core = true, requireUv = false) {
  const { db, sqlite } = createTestDb();
  seedNode(sqlite, { id: A });
  seedNode(sqlite, { id: B });
  seedCheck(sqlite, { id: CHECK, nodeId: A });
  const env = { DB: db, PUBLIC_ORIGIN: ORIGIN } as unknown as Env;
  const call = (
    method: string,
    path: string,
    body?: unknown,
    confirm?: string,
  ) =>
    app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(confirm ? { "x-kry-proof": confirm } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  const phone = await testPasskey("phone");
  await call("POST", "/api/devices", {
    id: phone.id,
    name: phone.name,
    alg: phone.alg,
    publicKey: phone.publicKey,
    verifies: true,
  });
  if (core) {
    const print = await fingerprint(phone.publicKey);
    sqlite.prepare("UPDATE nodes SET trust_report = ?").run(
      JSON.stringify({
        version: 1,
        core: [print],
        access: [print],
        passphrase: false,
        requireUv,
      }),
    );
  }
  const code = async (response: Response) =>
    ((await response.clone().json()) as { code?: string }).code;
  return { call, phone, code };
}

describe("dashboard actions that destroy or hide", () => {
  it("need no fingerprint while the owner has no core devices", async () => {
    const t = await setup(false);
    const enroll = await t.call("POST", "/api/enrollments");
    expect(
      ((await enroll.json()) as { command: string }).command,
    ).not.toContain("--trust");
    expect((await t.call("DELETE", `/api/nodes/${A}`)).status).toBe(204);
  });

  it("refuse to delete a server without a fingerprint, or with one for another server", async () => {
    const t = await setup();
    const bare = await t.call("DELETE", `/api/nodes/${A}`);
    expect(bare.status).toBe(403);
    expect(await bare.json()).toMatchObject({
      code: "PROOF_NEEDED",
      op: "node.delete",
      target: A,
      core: ["phone"],
    });
    const other = await t.call(
      "DELETE",
      `/api/nodes/${A}`,
      undefined,
      await proof(t.phone, "node.delete", B),
    );
    expect(other.status).toBe(400);
    expect(await t.code(other)).toBe("BAD_PROOF");
    const stale = await t.call(
      "DELETE",
      `/api/nodes/${A}`,
      undefined,
      await proof(t.phone, "node.delete", A, { at: Date.now() - 180_000 }),
    );
    expect(stale.status).toBe(400);
    const good = await t.call(
      "DELETE",
      `/api/nodes/${A}`,
      undefined,
      await proof(t.phone, "node.delete", A),
    );
    expect(good.status).toBe(204);
  });

  it("refuse a passkey that skipped the fingerprint when servers require one", async () => {
    const t = await setup(true, true);
    const response = await t.call(
      "DELETE",
      `/api/nodes/${A}`,
      undefined,
      await proof(t.phone, "node.delete", A, { verified: false }),
    );
    expect(response.status).toBe(400);
    expect(await t.code(response)).toBe("FINGERPRINT_NEEDED");
  });

  it("guard pausing, retargeting and deleting a check and new enrollments, not renames", async () => {
    const t = await setup();
    expect(
      (await t.call("PATCH", `/api/checks/${CHECK}`, { name: "Web" })).status,
    ).toBe(200);
    expect(
      (await t.call("PATCH", `/api/checks/${CHECK}`, { enabled: false }))
        .status,
    ).toBe(403);
    expect(
      (await t.call("PATCH", `/api/checks/${CHECK}`, { nodeId: B })).status,
    ).toBe(403);
    expect(
      (
        await t.call(
          "PATCH",
          `/api/checks/${CHECK}`,
          { enabled: false },
          await proof(t.phone, "check.change", CHECK),
        )
      ).status,
    ).toBe(200);
    expect((await t.call("DELETE", `/api/checks/${CHECK}`)).status).toBe(403);
    expect((await t.call("POST", "/api/enrollments")).status).toBe(403);
    const enroll = await t.call(
      "POST",
      "/api/enrollments",
      undefined,
      await proof(t.phone, "enrollment.create", "new"),
    );
    expect(enroll.status).toBe(201);
    expect(((await enroll.json()) as { command: string }).command).toContain(
      ` --trust ${ORIGIN} --grant -- phone.-7.${t.phone.publicKey}`,
    );
  });
});
