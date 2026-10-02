import { describe, expect, it } from "vitest";

import quorum from "./fixtures/quorum.json";
import { evaluateQuorum } from "./quorum";

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
      current: { core: ["a", "b", "c"], access: ["a", "b", "c"] },
      change: { core: ["a", "b", "c", "d"], access: ["a", "b", "c"] },
      approvals: ["a"],
    });
    expect(result).toEqual({ ok: false, reason: "needs 1 more approval" });
    expect(
      evaluateQuorum({
        current: { core: ["a", "b", "c"], access: ["a", "b", "c"] },
        change: { core: ["b", "c"], access: ["b", "c"] },
        approvals: [],
      }),
    ).toEqual({ ok: false, reason: "needs an approval" });
  });
});
