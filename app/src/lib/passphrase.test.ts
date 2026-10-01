import { proofMessage } from "@krynodes/protocol/quorum";
import { describe, expect, it } from "vitest";

import { signProof, unlockPassphrase } from "./passphrase";
import { b64url, fromB64url } from "./passkeys";

const RECORD = {
  salt: "AAECAwQFBgcICQoLDA0ODw",
  iterations: 600000,
  publicKey: "_K0-Bfagmf_Jx6zhs7liJQ92RMtDjmgTQLxj6GQUfls",
};

const verify = async (
  publicKey: string,
  purpose: string,
  data: Uint8Array<ArrayBuffer>,
  proof: string,
) => {
  const key = await crypto.subtle.importKey(
    "raw",
    fromB64url(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const digest = b64url(await crypto.subtle.digest("SHA-256", data));
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    fromB64url(proof),
    new TextEncoder().encode(proofMessage(purpose, digest)),
  );
};

describe("passphrase", { timeout: 60_000 }, () => {
  it("derives the same key the Go reference derives", async () => {
    const key = await unlockPassphrase("correct horse battery staple", RECORD);
    const data = new TextEncoder().encode("grant bytes");
    const proof = await signProof(key, "grant", data);
    expect(await verify(RECORD.publicKey, "grant", data, proof)).toBe(true);
    expect(await verify(RECORD.publicKey, "approve:x", data, proof)).toBe(
      false,
    );
  });

  it("refuses a wrong passphrase in the tab", async () => {
    await expect(
      unlockPassphrase("correct horse battery stable", RECORD),
    ).rejects.toThrow("The passphrase is wrong.");
  });
});
