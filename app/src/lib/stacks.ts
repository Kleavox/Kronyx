import type {
  ActionRecord,
  NodeRecord,
  NodeTrust,
  ServiceEntry,
  ServicesResponse,
  StackEntry,
} from "../types";
import { MIN_AGENT_VERSION } from "@krynodes/protocol/versions";

import { agentCurrent } from "./devices";
import { nodeState } from "./format";

export interface StackMember {
  node: NodeRecord;
  stack: StackEntry;
  trusted: boolean;
  trust: NodeTrust | null;
  action: ActionRecord | null;
}

export interface StackGroup {
  project: string;
  members: StackMember[];
}

const healthy = (group: StackGroup) =>
  group.members.every((member) => member.stack.running === member.stack.total);

export function groupStacks(
  data: ServicesResponse,
  nodes: NodeRecord[],
  query: string,
): StackGroup[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const latest = new Map<string, ActionRecord>();
  for (const action of data.actions) {
    if (action.kind === "compose") {
      latest.set(`${action.nodeId}|${action.name}`, action);
    }
  }
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, StackGroup>();
  for (const entry of data.nodes) {
    const node = byId.get(entry.id);
    if (!node) continue;
    for (const stack of entry.stacks) {
      if (
        needle &&
        !stack.project.includes(needle) &&
        !node.name.toLowerCase().includes(needle)
      ) {
        continue;
      }
      const group = groups.get(stack.project) ?? {
        project: stack.project,
        members: [],
      };
      group.members.push({
        node,
        stack,
        trusted: (entry.trust?.access.length ?? 0) > 0,
        trust: entry.trust,
        action: latest.get(`${node.id}|${stack.project}`) ?? null,
      });
      groups.set(stack.project, group);
    }
  }
  const sorted = [...groups.values()];
  for (const group of sorted) {
    group.members.sort((a, b) => a.node.name.localeCompare(b.node.name));
  }
  return sorted.sort(
    (a, b) =>
      Number(healthy(a)) - Number(healthy(b)) ||
      a.project.localeCompare(b.project),
  );
}

export function deployBlocker(member: StackMember): string | null {
  if (!agentCurrent(member.node)) return `Needs agent ${MIN_AGENT_VERSION}`;
  if (!member.stack.compose) return "Docker Compose is not installed";
  if (!member.trusted) return "Not trusted yet";
  return null;
}

export function deployTargets(
  members: StackMember[],
  seen: number,
): StackMember[] {
  return members
    .filter((member) => deployBlocker(member) === null)
    .sort(
      (a, b) =>
        Number(nodeState(a.node, seen) === "offline") -
        Number(nodeState(b.node, seen) === "offline"),
    );
}

export function containersOf(
  project: string,
  services: ServiceEntry[],
): ServiceEntry[] {
  return services
    .filter(
      (service) =>
        service.kind === "docker" &&
        (service.name.startsWith(`${project}-`) ||
          service.name.startsWith(`${project}_`)),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
