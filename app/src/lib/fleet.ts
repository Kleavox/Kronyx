import type { AgentState } from "./agent";
import type { NodeState } from "./format";
import type { Severity } from "./health";

export type FleetFilter = "all" | "issues" | "offline" | "updates";

export interface FleetRow {
  name: string;
  hostname: string | null;
  system: string | null;
  state: NodeState;
  severity: Severity;
  agent: AgentState;
}

const BEHIND: AgentState[] = ["available", "failed", "unsupported"];

export function matchesFleet(
  row: FleetRow,
  filter: FleetFilter,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (
    needle &&
    ![row.name, row.hostname ?? "", row.system ?? ""].some((field) =>
      field.toLowerCase().includes(needle),
    )
  ) {
    return false;
  }
  if (filter === "issues") {
    return row.severity === "critical" || row.severity === "warning";
  }
  if (filter === "offline") return row.state === "offline";
  if (filter === "updates") return BEHIND.includes(row.agent);
  return true;
}

export function fleetCounts(rows: FleetRow[]): Record<FleetFilter, number> {
  const count = (filter: FleetFilter) =>
    rows.filter((row) => matchesFleet(row, filter, "")).length;
  return {
    all: rows.length,
    issues: count("issues"),
    offline: count("offline"),
    updates: count("updates"),
  };
}
