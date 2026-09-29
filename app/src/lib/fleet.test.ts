import { describe, expect, it } from "vitest";

import { fleetCounts, matchesFleet, type FleetRow } from "./fleet";

const row = (extra: Partial<FleetRow>): FleetRow => ({
  name: "web-01",
  hostname: "web-01",
  system: "Debian 12.10",
  state: "online",
  severity: "healthy",
  agent: "current",
  ...extra,
});

const rows = [
  row({}),
  row({ name: "db-01", hostname: "db-01", severity: "warning" }),
  row({
    name: "edge",
    hostname: "edge-sg",
    state: "offline",
    severity: "critical",
  }),
  row({
    name: "arm",
    hostname: "arm",
    system: "Ubuntu 24.04.1",
    agent: "available",
  }),
  row({ name: "old", hostname: "old", agent: "failed" }),
];

describe("matchesFleet", () => {
  it("filters issues, offline servers and agents behind", () => {
    expect(
      rows.filter((r) => matchesFleet(r, "issues", "")).map((r) => r.name),
    ).toEqual(["db-01", "edge"]);
    expect(
      rows.filter((r) => matchesFleet(r, "offline", "")).map((r) => r.name),
    ).toEqual(["edge"]);
    expect(
      rows.filter((r) => matchesFleet(r, "updates", "")).map((r) => r.name),
    ).toEqual(["arm", "old"]);
    expect(rows.filter((r) => matchesFleet(r, "all", ""))).toHaveLength(5);
  });

  it("searches name, hostname and system, ignoring case", () => {
    expect(
      rows.filter((r) => matchesFleet(r, "all", "SG")).map((r) => r.name),
    ).toEqual(["edge"]);
    expect(
      rows.filter((r) => matchesFleet(r, "all", "ubuntu")).map((r) => r.name),
    ).toEqual(["arm"]);
    expect(
      rows.filter((r) => matchesFleet(r, "updates", "old")).map((r) => r.name),
    ).toEqual(["old"]);
  });
});

describe("fleetCounts", () => {
  it("counts each filter for the chips", () => {
    expect(fleetCounts(rows)).toEqual({
      all: 5,
      issues: 2,
      offline: 1,
      updates: 2,
    });
  });
});
