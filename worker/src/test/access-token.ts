import { vi } from "vitest";

export const ACCESS_TEAM = "example.cloudflareaccess.com";
export const ACCESS_AUD = "aud-tag-123";

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");

const encode = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function accessKeys(kid = "key-1") {
  const pair = (await crypto.subtle.generateKey(RSA, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  const jwk = { ...exported, kid };
  return { privateKey: pair.privateKey, jwk };
}

export function accessClaims(now: number, extra: Record<string, unknown> = {}) {
  return {
    aud: [ACCESS_AUD],
    iss: `https://${ACCESS_TEAM}`,
    email: "operator@example.test",
    iat: now / 1000 - 60,
    exp: now / 1000 + 3600,
    ...extra,
  };
}

export async function signAccessToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  kid = "key-1",
): Promise<string> {
  const data = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(data),
  );
  return `${data}.${base64url(new Uint8Array(signature))}`;
}

export function serveAccessCerts(jwk: JsonWebKey) {
  const fetch = vi.fn(async () => Response.json({ keys: [jwk] }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
