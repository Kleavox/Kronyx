import { describe, expect, it } from "vitest";

import { trustChangeSchema } from "./change";
import { summarizeChange } from "./summary";

const names = { a: "Laptop", b: "Phone", c: "Tablet" };
const N1 = "11111111-1111-4111-8111-111111111111";
const N2 = "22222222-2222-4222-8222-222222222222";

describe("change summaries", () => {
  it("names an admission", () => {
    const summary = summarizeChange({
      names,
      currentCore: ["a"],
      currentAccess: { [N1]: ["a"], [N2]: ["a"] },
      currentPassphrase: false,
      change: {
        core: ["a", "b"],
        passphrase: false,
        access: { [N1]: ["a", "b"], [N2]: ["a", "b"] },
      },
    });
    expect(summary.title).toBe("Admit Phone");
    expect(summary.admitted).toEqual(["b"]);
    expect(summary.access).toEqual([
      { nodeId: N1, added: ["b"], removed: [] },
      { nodeId: N2, added: ["b"], removed: [] },
    ]);
  });

  it("names a removal, an access change and a passphrase", () => {
    expect(
      summarizeChange({
        names,
        currentCore: ["a", "b", "c"],
        currentAccess: { [N1]: ["a", "c"] },
        currentPassphrase: true,
        change: {
          core: ["a", "b"],
          passphrase: false,
          access: { [N1]: ["a"] },
        },
      }).title,
    ).toBe("Remove Tablet");
    expect(
      summarizeChange({
        names,
        currentCore: ["a", "b"],
        currentAccess: { [N1]: ["a"], [N2]: ["a"] },
        currentPassphrase: false,
        change: {
          core: null,
          passphrase: false,
          access: { [N1]: ["a", "b"], [N2]: ["a", "b"] },
        },
      }).title,
    ).toBe("Change access on 2 servers");
    expect(
      summarizeChange({
        names,
        currentCore: ["a", "b"],
        currentAccess: { [N1]: ["a", "b"] },
        currentPassphrase: false,
        change: { core: null, passphrase: true, access: { [N1]: ["a", "b"] } },
      }).title,
    ).toBe("Set passphrase");
    expect(
      summarizeChange({
        names,
        currentCore: ["a", "b"],
        currentAccess: { [N1]: ["a", "b"] },
        currentPassphrase: true,
        change: { core: null, passphrase: true, access: { [N1]: ["a", "b"] } },
      }).title,
    ).toBe("Change passphrase");
  });

  it("names turning on fingerprints next to the removal it needs", () => {
    const summary = summarizeChange({
      names,
      currentCore: ["a", "b"],
      currentAccess: { [N1]: ["a", "b"] },
      currentPassphrase: true,
      change: {
        core: ["b"],
        passphrase: false,
        requireUv: true,
        access: { [N1]: ["b"] },
      },
    });
    expect(summary.title).toBe("Remove Laptop · Require fingerprint");
    expect(summary.requireUv).toBe(true);
  });

  it("parses a change and refuses one of the old format", () => {
    const change = {
      v: 2,
      origin: "https://kry.example.test",
      rpId: "kry.example.test",
      version: 3,
      issuedAt: "2026-09-30T10:00:00.000Z",
      expiresAt: "2026-10-01T10:00:00.000Z",
      core: null,
      passphrase: null,
      access: { [N1]: ["YQ"] },
    };
    expect(trustChangeSchema.safeParse(change).success).toBe(true);
    expect(
      trustChangeSchema.safeParse({ ...change, v: 1, nodeIds: [N1] }).success,
    ).toBe(false);
    expect(
      trustChangeSchema.safeParse({ ...change, requireUv: true }).success,
    ).toBe(true);
    expect(
      trustChangeSchema.safeParse({ ...change, requireUv: false }).success,
    ).toBe(false);
  });
});
