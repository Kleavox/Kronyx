import { describe, expect, it } from "vitest";

import {
  expandResults,
  mergeChecks,
  parseChecks,
  staleAfterMs,
  windowSize,
  windowStart,
} from "./windows";

const BASE = Date.parse("2026-10-01T08:00:00.000Z");
const A = "check-a";
const B = "check-b";

describe("windows", () => {
  it("aligns a window to five minutes, or to a longer interval", () => {
    expect(windowSize(60)).toBe(300_000);
    expect(windowSize(900)).toBe(900_000);
    expect(windowStart(BASE + 299_999, 60)).toBe("2026-10-01T08:00:00.000Z");
    expect(windowStart(BASE + 300_000, 60)).toBe("2026-10-01T08:05:00.000Z");
  });

  it("keeps the first result and lets a failure win, with its message", () => {
    const up = mergeChecks({}, [
      { checkId: A, status: "UP", latencyMs: 40, message: null },
    ]);
    expect(up).toEqual({ [A]: ["UP", 40] });
    const same = mergeChecks(up, [
      { checkId: A, status: "UP", latencyMs: 90, message: null },
    ]);
    expect(same).toBe(up);
    const down = mergeChecks(up, [
      { checkId: A, status: "DOWN", latencyMs: null, message: "timeout" },
      { checkId: B, status: "UP", latencyMs: 12, message: "ignored" },
    ]);
    expect(down).toEqual({
      [A]: ["DOWN", null, "timeout"],
      [B]: ["UP", 12],
    });
    expect(
      mergeChecks(down, [
        { checkId: A, status: "UP", latencyMs: 5, message: null },
      ]),
    ).toBe(down);
  });

  it("reads stored checks defensively", () => {
    expect(parseChecks(null)).toEqual({});
    expect(parseChecks("not json")).toEqual({});
    expect(parseChecks('["x"]')).toEqual({});
    expect(
      parseChecks(
        JSON.stringify({ [A]: ["UP", 3], [B]: ["MAYBE", 1], c: "x" }),
      ),
    ).toEqual({ [A]: ["UP", 3] });
  });

  it("expands window rows into per-check results for known checks", () => {
    const rows = [
      {
        window_start: "2026-10-01T08:05:00.000Z",
        checks: JSON.stringify({
          [A]: ["DOWN", null, "HTTP 502"],
          gone: ["UP", 1],
        }),
      },
      {
        window_start: "2026-10-01T08:00:00.000Z",
        checks: JSON.stringify({ [A]: ["UP", 40], [B]: ["UP", 9] }),
      },
    ];
    const expanded = expandResults(rows, new Set([A, B]));
    expect(expanded.get(A)).toEqual([
      {
        t: "2026-10-01T08:00:00.000Z",
        status: "UP",
        latencyMs: 40,
        message: null,
      },
      {
        t: "2026-10-01T08:05:00.000Z",
        status: "DOWN",
        latencyMs: null,
        message: "HTTP 502",
      },
    ]);
    expect(expanded.get(B)).toHaveLength(1);
    expect(expanded.has("gone")).toBe(false);
  });

  it("waits a window and two reports before calling a server silent", () => {
    expect(staleAfterMs(60)).toBe(420_000);
    expect(staleAfterMs(900)).toBe(2_700_000);
  });
});
