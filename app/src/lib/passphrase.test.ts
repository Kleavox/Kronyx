import { proofMessage } from "@krynodes/protocol/quorum";
import { describe, expect, it } from "vitest";

import {
  createPassphrase,
  passphraseProblem,
  passphraseStrength,
  signProof,
  unlockPassphrase,
} from "./passphrase";
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

  it("normalizes the passphrase before deriving", async () => {
    await expect(
      unlockPassphrase("correct horse battery staple", RECORD),
    ).resolves.toBeDefined();
    const composed = await createPassphrase("café mountain river");
    await expect(
      unlockPassphrase("café mountain river", composed.record),
    ).resolves.toBeDefined();
  });

  it("refuses a wrong passphrase in the tab", async () => {
    await expect(
      unlockPassphrase("correct horse battery stable", RECORD),
    ).rejects.toThrow("The passphrase is wrong.");
  });

  it("creates a fresh salt with 600,000 iterations", async () => {
    const one = await createPassphrase("a long enough passphrase");
    const two = await createPassphrase("a long enough passphrase");
    expect(one.record.iterations).toBe(600000);
    expect(fromB64url(one.record.salt)).toHaveLength(16);
    expect(one.record.salt).not.toBe(two.record.salt);
    expect(fromB64url(one.record.publicKey)).toHaveLength(32);
    const data = new TextEncoder().encode("change");
    expect(
      await verify(
        one.record.publicKey,
        "approve:abc",
        data,
        await signProof(one.key, "approve:abc", data),
      ),
    ).toBe(true);
  });

  it("refuses short and common passphrases", () => {
    expect(passphraseProblem("short one")).toBe("Use at least 12 characters.");
    expect(passphraseProblem("password1234")).toBe(
      "This passphrase is too common. Pick words nobody would guess.",
    );
    expect(passphraseProblem("aaaaaaaaaaaaaaa")).toBe(
      "This passphrase is too common. Pick words nobody would guess.",
    );
    expect(passphraseProblem("violet harbor lantern")).toBeNull();
  });

  it("hints at the strength", () => {
    expect(passphraseStrength("")).toBe("");
    expect(passphraseStrength("twelve chars")).toBe("Weak");
    expect(passphraseStrength("violet harbor lantern")).toBe("Good");
    expect(passphraseStrength("violet harbor lantern quietly 42")).toBe(
      "Strong",
    );
  });
});
