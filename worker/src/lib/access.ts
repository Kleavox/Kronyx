export interface AccessConfig {
  teamDomain: string;
  audience: string;
}

interface AccessClaims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
}

const KEY_TTL_MS = 3_600_000;
const REFETCH_GAP_MS = 300_000;
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

let cache: {
  team: string;
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
} | null = null;

function decodePart(part: string): Uint8Array {
  const base64 = part.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodePart(part)));
}

async function loadKeys(team: string, now: number) {
  const response = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error(`Access certs responded with ${response.status}`);
  }
  const body = await response.json<{
    keys: (JsonWebKey & { kid: string })[];
  }>();
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, ALGORITHM, false, ["verify"]),
    );
  }
  cache = { team, keys, fetchedAt: now };
  return keys;
}

async function keyFor(team: string, kid: string, now: number) {
  const age = cache && cache.team === team ? now - cache.fetchedAt : Infinity;
  if (cache && age < KEY_TTL_MS && cache.keys.has(kid)) {
    return cache.keys.get(kid);
  }
  if (age < REFETCH_GAP_MS) return undefined;
  return (await loadKeys(team, now)).get(kid);
}

export async function verifyAccessToken(
  request: Request,
  config: AccessConfig,
  now = Date.now(),
): Promise<{ email: string } | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  let signed: Uint8Array;
  try {
    header = decodeJson(head) as typeof header;
    claims = decodeJson(body) as AccessClaims;
    signed = decodePart(signature);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const team = config.teamDomain
    .replace(/^https?:\/\//u, "")
    .replace(/\/+$/u, "");
  const key = await keyFor(team, header.kid, now);
  if (!key) return null;
  const valid = await crypto.subtle.verify(
    ALGORITHM,
    key,
    signed,
    new TextEncoder().encode(`${head}.${body}`),
  );
  if (!valid) return null;

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const seconds = now / 1000;
  if (
    !audiences.includes(config.audience) ||
    claims.iss !== `https://${team}` ||
    typeof claims.exp !== "number" ||
    claims.exp <= seconds ||
    (typeof claims.nbf === "number" && claims.nbf > seconds)
  ) {
    return null;
  }
  return { email: typeof claims.email === "string" ? claims.email : "" };
}
