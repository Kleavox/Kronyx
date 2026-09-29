import type {
  ActionRecord,
  CheckRecord,
  NodeRecord,
  ServiceAction,
  ServiceEntry,
  ServiceKind,
  ServicesResponse,
  ServiceState,
} from "../types";
import { clockTime, nodeState, parseTimestamp } from "./format";
import { untilWindowSettles } from "./series";

const PENDING_POLL_MS = 5_000;
const REFRESH_WAIT_MS = 3 * 60_000;

const WORDS: Record<
  ServiceAction,
  { verb: string; doing: string; done: string }
> = {
  start: { verb: "Start", doing: "Starting…", done: "Started" },
  stop: { verb: "Stop", doing: "Stopping…", done: "Stopped" },
  restart: { verb: "Restart", doing: "Restarting…", done: "Restarted" },
};

export interface ActionTarget {
  nodeId: string;
  nodeName: string;
  kind: ServiceKind;
  name: string;
  offline?: boolean;
}

export interface ServiceMember {
  node: NodeRecord;
  entry: ServiceEntry;
  action: ActionRecord | null;
}

export interface ServiceGroup {
  key: string;
  kind: ServiceKind;
  name: string;
  members: ServiceMember[];
}

export function displayName(kind: ServiceKind, name: string): string {
  return kind === "systemd" ? name.replace(/\.service$/u, "") : name;
}

export function verb(action: ServiceAction): string {
  return WORDS[action].verb;
}

export function isPending(action: ActionRecord | null | undefined): boolean {
  return action?.status === "queued" || action?.status === "sent";
}

export function primaryAction(state: ServiceState): ServiceAction {
  return state === "running" || state === "starting" ? "restart" : "start";
}

export function running(group: ServiceGroup): number {
  return group.members.filter((member) => member.entry.state === "running")
    .length;
}

export function groupPrimary(group: ServiceGroup): ServiceAction {
  return running(group) === 0 ? "start" : "restart";
}

export function toTarget(member: ServiceMember): ActionTarget {
  return {
    nodeId: member.node.id,
    nodeName: member.node.name,
    kind: member.entry.kind,
    name: member.entry.name,
  };
}

export function bulkTargets(group: ServiceGroup, seen: number): ActionTarget[] {
  return group.members
    .map((member) => ({
      ...toTarget(member),
      offline: nodeState(member.node, seen) === "offline",
    }))
    .sort((a, b) => Number(a.offline) - Number(b.offline));
}

export function groupServices(
  data: ServicesResponse,
  nodes: NodeRecord[],
  options: { showSystem: boolean; query: string; notRunning: boolean },
): ServiceGroup[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const latest = new Map<string, ActionRecord>();
  for (const action of data.actions) {
    latest.set(`${action.nodeId}|${action.kind}:${action.name}`, action);
  }
  const query = options.query.trim().toLowerCase();
  const groups = new Map<string, ServiceGroup>();
  for (const inventory of data.nodes) {
    const node = byId.get(inventory.id);
    if (!node) continue;
    for (const entry of inventory.services) {
      if (entry.system && !options.showSystem) continue;
      const label = displayName(entry.kind, entry.name).toLowerCase();
      if (
        query &&
        !label.includes(query) &&
        !node.name.toLowerCase().includes(query)
      ) {
        continue;
      }
      const key = `${entry.kind}:${entry.name}`;
      const group = groups.get(key) ?? {
        key,
        kind: entry.kind,
        name: entry.name,
        members: [],
      };
      group.members.push({
        node,
        entry,
        action: latest.get(`${node.id}|${key}`) ?? null,
      });
      groups.set(key, group);
    }
  }
  const healthy = (group: ServiceGroup) =>
    running(group) === group.members.length;
  return [...groups.values()]
    .map((group) => ({
      ...group,
      members: [...group.members].sort((a, b) =>
        a.node.name.localeCompare(b.node.name),
      ),
    }))
    .filter((group) => !options.notRunning || !healthy(group))
    .sort(
      (a, b) =>
        Number(healthy(a)) - Number(healthy(b)) ||
        displayName(a.kind, a.name).localeCompare(displayName(b.kind, b.name)),
    );
}

export function nextReportIn(now: number): number {
  const since = (((now - 2_000) % 60_000) + 60_000) % 60_000;
  return Math.ceil((60_000 - since) / 1_000);
}

export function actionText(
  action: ActionRecord,
  nodeName: string,
  now: number,
): string {
  const words = WORDS[action.action];
  switch (action.status) {
    case "queued":
      return action.deliverableAt
        ? `Waiting for ${nodeName} · ~${nextReportIn(now)}s`
        : "Waiting for its turn";
    case "sent":
      return words.doing;
    case "done":
      return `✓ ${words.done} ${clockTime(action.finishedAt ?? action.requestedAt)}`;
    case "failed":
      return action.exitCode === null
        ? "Failed"
        : `Failed · exit ${action.exitCode}`;
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return "Skipped";
  }
}

export function actionStage(action: ActionRecord, nodeName: string): string {
  if (action.status === "queued") {
    return action.deliverableAt
      ? `Waiting for ${nodeName}`
      : "Waiting for its turn";
  }
  return actionText(action, nodeName, 0);
}

export function durationText(action: ActionRecord): string | null {
  if (!action.sentAt || !action.finishedAt) return null;
  const seconds =
    (parseTimestamp(action.finishedAt) - parseTimestamp(action.sentAt)) / 1_000;
  return `${Math.max(1, Math.round(seconds))}s`;
}

export function batchText(
  batch: ActionRecord[],
  nodeName: (id: string) => string,
): string | null {
  if (batch.length < 2) return null;
  const ordered = [...batch].sort((a, b) => a.position - b.position);
  const first = ordered[0]!;
  const doing = WORDS[first.action].doing.replace("…", "");
  const stopped = ordered.find(
    (entry) => entry.status === "failed" || entry.status === "expired",
  );
  if (stopped && ordered.some((entry) => entry.status === "skipped")) {
    return `Stopped at ${nodeName(stopped.nodeId)}`;
  }
  const current = ordered.find((entry) => isPending(entry));
  if (!current) return null;
  if (first.mode === "parallel") return `${doing} ${ordered.length} servers`;
  const done = ordered.filter((entry) => entry.status === "done").length;
  return `${doing} ${done + 1}/${ordered.length} · ${nodeName(current.nodeId)}`;
}

export function pollServices(
  data: ServicesResponse | undefined,
  now: number,
): number {
  const busy =
    data !== undefined &&
    (data.actions.some(isPending) ||
      data.nodes.some((node) => refreshPending(node, now)));
  return busy ? PENDING_POLL_MS : untilWindowSettles(now);
}

export function refreshPending(
  node: { refreshRequestedAt: string | null },
  now: number,
): boolean {
  if (node.refreshRequestedAt === null) return false;
  const at = parseTimestamp(node.refreshRequestedAt);
  return Number.isFinite(at) && now - at < REFRESH_WAIT_MS;
}

export function serviceForCheck(
  check: Pick<CheckRecord, "kind" | "target" | "node_id">,
  data: ServicesResponse | undefined,
): ServiceEntry | null {
  if (check.kind !== "SERVICE" || !data) return null;
  const name = check.target.endsWith(".service")
    ? check.target
    : `${check.target}.service`;
  return (
    data.nodes
      .find((node) => node.id === check.node_id)
      ?.services.find(
        (service) => service.kind === "systemd" && service.name === name,
      ) ?? null
  );
}

export function newlyFinished(
  previous: ActionRecord[],
  next: ActionRecord[],
): ActionRecord[] {
  const pending = new Set(
    previous.filter(isPending).map((action) => action.id),
  );
  return next.filter((action) => pending.has(action.id) && !isPending(action));
}

export function outcomeText(
  action: ActionRecord,
  nodeName: string,
): { ok: boolean; text: string } | null {
  const name = displayName(action.kind, action.name);
  const words = WORDS[action.action];
  if (action.status === "done") {
    return {
      ok: true,
      text: `${name} ${words.done.toLowerCase()} on ${nodeName}`,
    };
  }
  if (action.status === "failed" || action.status === "expired") {
    const why =
      action.status === "expired"
        ? "expired"
        : action.exitCode === null
          ? "failed"
          : `exit ${action.exitCode}`;
    return {
      ok: false,
      text: `Could not ${words.verb.toLowerCase()} ${name} on ${nodeName} (${why})`,
    };
  }
  return null;
}
