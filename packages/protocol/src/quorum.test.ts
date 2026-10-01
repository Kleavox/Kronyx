import { describe, expect, it } from "vitest";

import quorum from "./fixtures/quorum.json";
import { evaluateQuorum, proofMessage } from "./quorum";

describe("quorum", () => {
  for (const item of quorum.cases) {
    it(item.name, () => {
      const result = evaluateQuorum({
        current: item.current,
        change: item.change,
        approvals: item.approvals,
      });
      expect(result.ok, JSON.stringify(result)).toBe(item.ok);
    });
  }

  it("says what is missing", () => {
    const result = evaluateQuorum({
      current: { core: ["a", "b"], access: ["a", "b"] },
      change: {
        core: ["a", "b", "c"],
        passphraseChanged: false,
        access: ["a", "b"],
      },
      approvals: [{ id: "a", verified: true }],
    });
    expect(result).toEqual({ ok: false, reason: "needs 1 more core device" });
  });
});

describe("passphrase proofs", () => {
  it("binds the purpose and the digest", () => {
    expect(proofMessage("grant", "ZGlnZXN0")).toBe(
      "krynodes-passphrase\ngrant\nZGlnZXN0",
    );
  });
});
