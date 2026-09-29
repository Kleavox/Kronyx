import type { NodeRecord } from "../types";

const UPDATE_TIMEOUT_MS = 10 * 60_000;
const VERSION = /^\d+\.\d+\.\d+$/u;

export type AgentState =
  "unknown" | "current" | "available" | "updating" | "failed";

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function agentState(
  node: Pick<
    NodeRecord,
    "agent_version" | "update_requested_version" | "update_requested_at"
  >,
  latest: string | null,
  now: number,
): AgentState {
  if (node.update_requested_version) {
    const requested = Date.parse(node.update_requested_at ?? "");
    return now - requested < UPDATE_TIMEOUT_MS ? "updating" : "failed";
  }
  const version = node.agent_version;
  if (!latest || !version || !VERSION.test(version)) return "unknown";
  return compareVersions(version, latest) >= 0 ? "current" : "available";
}
