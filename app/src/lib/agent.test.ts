import { describe, expect, it } from "vitest";

import { agentState, compareVersions } from "./agent";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function node(
  version: string | null,
  requested: string | null = null,
  at: string | null = null,
) {
  return {
    agent_version: version,
    update_requested_version: requested,
    update_requested_at: at,
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

  it("shows a request as updating for ten minutes, then as failed", () => {
    expect(agentState(node("0.5.1", "0.5.2", ago(3)), "0.5.2", NOW)).toBe(
      "updating",
    );
    expect(agentState(node("0.5.1", "0.5.2", ago(11)), "0.5.2", NOW)).toBe(
      "failed",
    );
  });
});
