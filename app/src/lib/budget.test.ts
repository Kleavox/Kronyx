import { describe, expect, it } from "vitest";

import {
  budgetLevel,
  estimateDailyUse,
  formatThousands,
  quotaLine,
} from "./budget";

const node = (
  id: string,
  interval = 60,
  extra: Partial<{
    disabled_at: string | null;
    enrolled_at: string | null;
  }> = {},
) => ({
  id,
  interval_seconds: interval,
  disabled_at: null,
  enrolled_at: "2026-09-01 00:00:00",
  ...extra,
});

describe("estimateDailyUse", () => {
  it("matches the design target of 5 nodes and 10 checks", () => {
    const nodes = ["a", "b", "c", "d", "e"].map((id) => node(id));
    const checks = nodes.flatMap((item) => [
      { node_id: item.id, enabled: 1 },
      { node_id: item.id, enabled: 1 },
    ]);
    expect(estimateDailyUse(nodes, checks)).toEqual({
      writes: 24_480,
      requests: 10_200,
    });
  });

  it("charges nothing for pending and disabled nodes or their checks", () => {
    expect(
      estimateDailyUse(
        [
          node("pending", 60, { enrolled_at: null }),
          node("off", 60, { disabled_at: "2026-09-02 00:00:00" }),
        ],
        [{ node_id: "pending", enabled: 1 }],
      ),
    ).toEqual({ writes: 0, requests: 3_000 });
  });

  it("scales with the node interval and skips paused checks", () => {
    expect(
      estimateDailyUse(
        [node("slow", 600)],
        [
          { node_id: "slow", enabled: 1 },
          { node_id: "slow", enabled: 0 },
        ],
      ),
    ).toEqual({ writes: 1_296, requests: 3_144 });
  });
});

describe("budget presentation", () => {
  it("warns from 80% of either share and flags going over", () => {
    expect(budgetLevel({ writes: 10_000, requests: 5_000 })).toBe("ok");
    expect(budgetLevel({ writes: 24_480, requests: 10_200 })).toBe("warn");
    expect(budgetLevel({ writes: 12_000, requests: 20_001 })).toBe("over");
  });

  it("formats thousands compactly", () => {
    expect(formatThousands(24_480)).toBe("24.5k");
    expect(formatThousands(30_000)).toBe("30k");
    expect(formatThousands(950)).toBe("950");
  });
});

describe("quotaLine", () => {
  it("names whichever share is closer to its limit", () => {
    expect(quotaLine({ writes: 24_480, requests: 10_200 })).toEqual({
      percent: 82,
      detail: "24.5k of 30k writes",
    });
    expect(quotaLine({ writes: 6_000, requests: 15_000 })).toEqual({
      percent: 75,
      detail: "15k of 20k requests",
    });
  });
});
