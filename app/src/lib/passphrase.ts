import { proofMessage } from "@krynodes/protocol/quorum";

import type { PassphraseKey } from "../types";
import { b64url, fromB64url } from "./passkeys";

const PKCS8_ED25519 = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

const encoder = new TextEncoder();

async function derive(passphrase: string, salt: string, iterations: number) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: fromB64url(salt), iterations },
      material,
      256,
    ),
  );
  const pkcs8 = new Uint8Array(PKCS8_ED25519.length + seed.length);
  pkcs8.set(PKCS8_ED25519);
  pkcs8.set(seed, PKCS8_ED25519.length);
  const exported = await crypto.subtle.exportKey(
    "jwk",
    await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, [
      "sign",
    ]),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  seed.fill(0);
  pkcs8.fill(0);
  return { key, publicKey: exported.x ?? "" };
}

export async function unlockPassphrase(
  passphrase: string,
  record: PassphraseKey,
): Promise<CryptoKey> {
  const { key, publicKey } = await derive(
    passphrase,
    record.salt,
    record.iterations,
  );
  if (publicKey !== record.publicKey) {
    throw new Error("The passphrase is wrong.");
  }
  return key;
}

export async function signProof(
  key: CryptoKey,
  purpose: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = b64url(await crypto.subtle.digest("SHA-256", data));
  return b64url(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      encoder.encode(proofMessage(purpose, digest)),
    ),
  );
}
