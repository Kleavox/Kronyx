import { afterEach, describe, expect, it, vi } from "vitest";

import {
  b64url,
  createSession,
  registerDevice,
  actionCommand,
  fromB64url,
  signCommand,
  signTargets,
  signTrustChange,
} from "./passkeys";

const T = Date.parse("2026-09-29T10:00:00.000Z");
const MINUTE = 60_000;
const decode = (text: string) =>
  JSON.parse(new TextDecoder().decode(fromB64url(text))) as Record<
    string,
    unknown
  >;

const authData = (flags: number) => {
  const bytes = new Uint8Array(37);
  bytes[32] = flags;
  return bytes.buffer;
};

function authenticator(flags = 0x05) {
  const seen: Uint8Array[] = [];
  vi.stubGlobal("navigator", {
    credentials: {
      get: async (options: CredentialRequestOptions) => {
        seen.push(new Uint8Array(options.publicKey!.challenge as ArrayBuffer));
        return {
          id: "ZGV2aWNl",
          authenticatorAttachment: "platform",
          response: {
            authenticatorData: authData(flags),
            clientDataJSON: new TextEncoder().encode("{}").buffer,
            signature: new Uint8Array([4, 5]).buffer,
          },
        };
      },
    },
  });
  return seen;
}

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("passkeys", () => {
  it("b64url round-trips without padding", () => {
    const bytes = new Uint8Array([0, 251, 255, 1]);
    expect(b64url(bytes)).toBe("APv_AQ");
    expect(fromB64url("APv_AQ")).toEqual(bytes);
  });

  it("builds a grant whose challenge is the SHA-256 of its bytes", async () => {
    const seen = authenticator();
    const session = await createSession(["ZGV2aWNl"], "kry.example.test", T);
    const grantBytes = fromB64url(session.grant.grant);
    expect(seen[0]).toEqual(await sha256(grantBytes));
    expect(decode(session.grant.grant)).toMatchObject({
      v: 1,
      rpId: "kry.example.test",
      issuedAt: new Date(T).toISOString(),
      expiresAt: new Date(T + 15 * MINUTE).toISOString(),
    });
    expect(session.grant).toMatchObject({
      credentialId: "ZGV2aWNl",
      authenticatorData: b64url(authData(0x05)),
      clientDataJSON: "e30",
      signature: "BAU",
    });
    expect(session.expiresAt).toBe(T + 15 * MINUTE);
  });

  it("signs a command the session key verifies (P1363)", async () => {
    authenticator();
    const session = await createSession(["ZGV2aWNl"], "kry.example.test", T);
    const command = actionCommand(
      {
        id: "55555555-5555-4555-8555-555555555555",
        nodeId: "11111111-1111-4111-8111-111111111111",
        kind: "compose",
        name: "listmonk",
        action: "deploy",
      },
      session,
      T + MINUTE,
    );
    const signed = await signCommand(session, command);
    const key = await crypto.subtle.importKey(
      "spki",
      fromB64url(decode(session.grant.grant).sessionKey as string),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = fromB64url(signed.signature);
    expect(signature).toHaveLength(64);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature,
        fromB64url(signed.command),
      ),
    ).toBe(true);
    expect(decode(signed.command)).toEqual({
      v: 1,
      id: "55555555-5555-4555-8555-555555555555",
      nodeId: "11111111-1111-4111-8111-111111111111",
      kind: "compose",
      name: "listmonk",
      action: "deploy",
      issuedAt: new Date(T + MINUTE).toISOString(),
      expiresAt: new Date(T + 75 * MINUTE).toISOString(),
    });
    expect(signed.grant).toBe(session.grant);
  });

  it("signs a trust change with a fresh assertion, or leaves the first one unsigned", async () => {
    const seen = authenticator();
    const change = { v: 1, nodeIds: ["n1"], version: 2 };
    const signed = await signTrustChange(change, ["ZGV2aWNl"]);
    expect(decode(signed.change)).toEqual(change);
    expect(seen[0]).toEqual(await sha256(fromB64url(signed.change)));
    expect(signed.assertion?.credentialId).toBe("ZGV2aWNl");
    const first = await signTrustChange(change, null);
    expect(first.assertion).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("signs every target before anything is sent", async () => {
    authenticator();
    const session = await createSession(["ZGV2aWNl"], "kry.example.test", T);
    const targets = await signTargets(
      session,
      "rollback",
      [
        {
          nodeId: "11111111-1111-4111-8111-111111111111",
          kind: "compose",
          name: "listmonk",
        },
      ],
      T + MINUTE,
    );
    expect(targets).toHaveLength(1);
    const [target] = targets;
    expect(target).toMatchObject({
      nodeId: "11111111-1111-4111-8111-111111111111",
      kind: "compose",
      name: "listmonk",
    });
    expect(decode(target!.signed.command)).toMatchObject({
      id: target!.id,
      action: "rollback",
      name: "listmonk",
    });
    expect(target).not.toHaveProperty("session");
  });

  it("signs a service action with its own kind", async () => {
    authenticator();
    const session = await createSession(["ZGV2aWNl"], "kry.example.test", T);
    const [target] = await signTargets(
      session,
      "restart",
      [
        {
          nodeId: "11111111-1111-4111-8111-111111111111",
          kind: "docker",
          name: "adguard",
        },
      ],
      T + MINUTE,
    );
    expect(target).toMatchObject({ kind: "docker", name: "adguard" });
    expect(decode(target!.signed.command)).toMatchObject({
      id: target!.id,
      nodeId: "11111111-1111-4111-8111-111111111111",
      kind: "docker",
      name: "adguard",
      action: "restart",
    });
  });

  it("accepts a passkey that reports presence without verification", async () => {
    authenticator(0x19);
    await expect(
      createSession(["ZGV2aWNl"], "kry.example.test", T),
    ).resolves.toMatchObject({ grant: { credentialId: "ZGV2aWNl" } });
  });

  it("stops at once when the passkey was not touched", async () => {
    authenticator(0x00);
    await expect(
      createSession(["ZGV2aWNl"], "kry.example.test", T),
    ).rejects.toThrow(/was not touched.*flags 0x00, platform/u);
  });

  it("refuses to set up a passkey that was not touched", async () => {
    const created = (flags: number) => ({
      create: async () => ({
        id: "bmV3",
        response: {
          getAuthenticatorData: () => authData(flags),
          getPublicKey: () => new Uint8Array([9, 9]).buffer,
          getPublicKeyAlgorithm: () => -7,
        },
      }),
    });
    const user = { id: "operator", name: "operator" };
    vi.stubGlobal("navigator", { credentials: created(0x40) });
    await expect(
      registerDevice("Laptop", "kry.example.test", user, []),
    ).rejects.toThrow(/was not touched/u);
    vi.stubGlobal("navigator", { credentials: created(0x59) });
    await expect(
      registerDevice("Laptop", "kry.example.test", user, []),
    ).resolves.toMatchObject({ id: "bmV3", alg: -7 });
  });
});
