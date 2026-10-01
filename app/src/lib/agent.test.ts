import { describe, expect, it } from "vitest";

import { agentState, compareVersions, needsOldPath } from "./agent";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function node(
  version: string | null,
  requested: string | null = null,
  at: string | null = null,
  attempts = 1,
) {
  return {
    agent_version: version,
    update_requested_version: requested,
    update_requested_at: at,
    update_attempts: attempts,
  };
}

describe("compareVersions", () => {
  it("orders release numbers numerically", () => {
    expect(compareVersions("0.5.10", "0.5.9")).toBeGreaterThan(0);
    expect(compareVersions("0.5.1", "0.5.1")).toBe(0);
  });
});

describe("agentState", () => {
  it("is unknown without a known release or a real agent version", () => {
    expect(agentState(node("0.5.1"), null, NOW)).toBe("unknown");
    expect(agentState(node("dev"), "0.5.2", NOW)).toBe("unknown");
    expect(agentState(node(null), "0.5.2", NOW)).toBe("unknown");
  });

  it("is current at or past the latest release", () => {
    expect(agentState(node("0.5.2"), "0.5.2", NOW)).toBe("current");
  });

  it("offers a remote update only to agents that can take one", () => {
    expect(agentState(node("0.5.1"), "0.5.2", NOW)).toBe("available");
    expect(agentState(node("0.1.0"), "0.2.0", NOW)).toBe("available");
  });

  it("keeps updating while Krynodes retries, and fails after the last attempt", () => {
    const state = (minutes: number, attempts: number) =>
      agentState(node("0.5.1", "0.5.2", ago(minutes), attempts), "0.5.2", NOW);
    expect(state(3, 1)).toBe("updating");
    expect(state(16, 1)).toBe("updating");
    expect(state(16, 3)).toBe("failed");
    expect(state(21, 2)).toBe("failed");
  });

  it("ignores a request the agent already passed, as after an update by hand", () => {
    expect(agentState(node("0.5.3", "0.5.2", ago(60)), "0.5.3", NOW)).toBe(
      "current",
    );
    expect(agentState(node("0.5.2", "0.5.2", ago(60)), "0.5.3", NOW)).toBe(
      "available",
    );
  });
});

describe("needsOldPath", () => {
  const server = (agent_version: string | null) => ({ agent_version });

  it("lists servers whose agent cannot use the live connection only", () => {
    const old = server("0.3.0");
    const unknown = server(null);
    const dev = server("dev");
    expect(
      needsOldPath([server("0.3.1"), old, server("0.4.0"), unknown, dev]),
    ).toEqual([old, unknown, dev]);
  });

  it("is empty once every server runs 0.3.1 or later", () => {
    expect(needsOldPath([server("0.3.1"), server("0.10.0")])).toEqual([]);
  });
});
