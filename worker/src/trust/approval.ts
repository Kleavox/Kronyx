import type { Env } from "../env";
import { verifyAssertion, verifyProof } from "../lib/webauthn";
import type { Fleet } from "./fleet";

interface Approval {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  proof?: string;
}

export class Refusal extends Error {
  readonly status: 400 | 403 | 404 | 409 | 410 | 422;
  readonly code: string;

  constructor(
    status: 400 | 403 | 404 | 409 | 410 | 422,
    code: string,
    message: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function verifyApproval(
  env: Env,
  fleet: Fleet,
  bytes: Uint8Array<ArrayBuffer>,
  approval: Approval,
  purpose: string,
) {
  const device = fleet.devices.find(
    (entry) => entry.id === approval.credentialId && entry.removedAt === null,
  );
  if (!device || !fleet.core.includes(device.id)) {
    throw new Refusal(403, "NOT_CORE", "Use the passkey of a core device.");
  }
  const origin = new URL(env.PUBLIC_ORIGIN);
  let uv: boolean;
  try {
    ({ uv } = await verifyAssertion(device, approval, {
      origin: origin.origin,
      rpId: origin.hostname,
      challenge: new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    }));
  } catch (error) {
    throw new Refusal(
      400,
      "BAD_APPROVAL",
      `The approval did not verify: ${(error as Error).message}.`,
    );
  }
  if (uv) return;
  if (fleet.requireUv) {
    throw new Refusal(
      400,
      "FINGERPRINT_NEEDED",
      "This passkey did not confirm a fingerprint. Use your phone or a security key.",
    );
  }
  if (!fleet.passphrase) return;
  if (!approval.proof) {
    throw new Refusal(
      400,
      "PASSPHRASE_NEEDED",
      "This device cannot prove a fingerprint. Enter the passphrase.",
    );
  }
  if (
    !(await verifyProof(
      fleet.passphrase.publicKey,
      purpose,
      bytes,
      approval.proof,
    ))
  ) {
    throw new Refusal(400, "PASSPHRASE_WRONG", "The passphrase is wrong.");
  }
}
