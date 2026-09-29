export const SESSION_MS = 15 * 60_000;
const COMMAND_GRACE_MS = 60 * 60_000;
export const TRUST_CHANGE_MS = 10 * 60_000;

export interface Assertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

interface SignedGrant extends Assertion {
  grant: string;
}

export interface SignedCommand {
  grant: SignedGrant;
  command: string;
  signature: string;
}

export interface SignedTrust {
  change: string;
  assertion: Assertion | null;
}

export interface Session {
  key: CryptoKey;
  grant: SignedGrant;
  issuedAt: number;
  expiresAt: number;
}

export interface DeviceInput {
  id: string;
  name: string;
  alg: number;
  publicKey: string;
}

const encoder = new TextEncoder();
const iso = (ms: number) => new Date(ms).toISOString();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

const random = (length: number) =>
  crypto.getRandomValues(new Uint8Array(length));

export async function registerDevice(
  name: string,
  rpId: string,
  user: { id: string; name: string },
  existing: string[],
): Promise<DeviceInput> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: "Krynodes" },
      user: {
        id: encoder.encode(user.id),
        name: user.name,
        displayName: user.name,
      },
      challenge: random(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "preferred",
      },
      attestation: "none",
      excludeCredentials: existing.map((id) => ({
        type: "public-key" as const,
        id: fromB64url(id),
      })),
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey();
  if (!publicKey)
    throw new Error("This browser does not share the passkey's public key.");
  return {
    id: credential.id,
    name,
    alg: response.getPublicKeyAlgorithm(),
    publicKey: b64url(publicKey),
  };
}

async function assert(
  challenge: Uint8Array<ArrayBuffer>,
  rpId: string | undefined,
  devices: string[],
): Promise<Assertion> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge,
      ...(rpId ? { rpId } : {}),
      allowCredentials: devices.map((id) => ({
        type: "public-key" as const,
        id: fromB64url(id),
      })),
      userVerification: "required",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("The passkey did not answer.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    credentialId: credential.id,
    authenticatorData: b64url(response.authenticatorData),
    clientDataJSON: b64url(response.clientDataJSON),
    signature: b64url(response.signature),
  };
}

export async function createSession(
  devices: string[],
  rpId: string,
  now = Date.now(),
): Promise<Session> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const expiresAt = now + SESSION_MS;
  const grantBytes = encoder.encode(
    JSON.stringify({
      v: 1,
      rpId,
      sessionKey: b64url(spki),
      issuedAt: iso(now),
      expiresAt: iso(expiresAt),
      nonce: b64url(random(16)),
    }),
  );
  const assertion = await assert(await sha256(grantBytes), rpId, devices);
  return {
    key: pair.privateKey,
    grant: { grant: b64url(grantBytes), ...assertion },
    issuedAt: now,
    expiresAt,
  };
}

export function deployCommand(
  target: { id: string; nodeId: string; name: string; action: string },
  session: Session,
  now = Date.now(),
) {
  return {
    v: 1,
    id: target.id,
    nodeId: target.nodeId,
    kind: "compose",
    name: target.name,
    action: target.action,
    issuedAt: iso(now),
    expiresAt: iso(session.expiresAt + COMMAND_GRACE_MS),
  };
}

export async function signCommand(
  session: Session,
  command: object,
): Promise<SignedCommand> {
  const bytes = encoder.encode(JSON.stringify(command));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    session.key,
    bytes,
  );
  return {
    grant: session.grant,
    command: b64url(bytes),
    signature: b64url(signature),
  };
}

export interface SignedTarget {
  id: string;
  nodeId: string;
  kind: "compose";
  name: string;
  signed: SignedCommand;
}

export function signDeployTargets(
  session: Session,
  action: "deploy" | "rollback",
  targets: { nodeId: string; name: string }[],
  now = Date.now(),
): Promise<SignedTarget[]> {
  return Promise.all(
    targets.map(async (target) => {
      const id = crypto.randomUUID();
      return {
        id,
        nodeId: target.nodeId,
        kind: "compose" as const,
        name: target.name,
        signed: await signCommand(
          session,
          deployCommand(
            { id, nodeId: target.nodeId, name: target.name, action },
            session,
            now,
          ),
        ),
      };
    }),
  );
}

export async function signTrustChange(
  change: object,
  devices: string[] | null,
  rpId?: string,
): Promise<SignedTrust> {
  const bytes = encoder.encode(JSON.stringify(change));
  if (!devices) return { change: b64url(bytes), assertion: null };
  return {
    change: b64url(bytes),
    assertion: await assert(await sha256(bytes), rpId, devices),
  };
}
