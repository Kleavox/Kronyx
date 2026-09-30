import type {
  ActionKind,
  ActionVerb,
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

const WORDS: Record<ActionVerb, { verb: string; doing: string; done: string }> =
  {
    start: { verb: "Start", doing: "Starting…", done: "Started" },
    stop: { verb: "Stop", doing: "Stopping…", done: "Stopped" },
    restart: { verb: "Restart", doing: "Restarting…", done: "Restarted" },
    deploy: { verb: "Deploy", doing: "Deploying…", done: "Deployed" },
    rollback: {
      verb: "Roll back",
      doing: "Rolling back…",
      done: "Rolled back",
    },
    trust: { verb: "Update", doing: "Updating…", done: "Updated" },
    reboot: { verb: "Restart", doing: "Restarting…", done: "Restarted" },
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

export interface ServerGroup {
  node: NodeRecord;
  trusted: boolean;
  members: ServiceMember[];
}

export function displayName(kind: ActionKind, name: string): string {
  if (kind === "trust") return "Trusted devices";
  if (kind === "host") return "server";
  return kind === "systemd" ? name.replace(/\.service$/u, "") : name;
}

export function verb(action: ActionVerb): string {
  return WORDS[action].verb;
}

export function isPending(action: ActionRecord | null | undefined): boolean {
  return action?.status === "queued" || action?.status === "sent";
}

export function primaryAction(state: ServiceState): ServiceAction {
  return state === "running" || state === "starting" ? "restart" : "start";
}

export function toTarget(member: ServiceMember): ActionTarget {
  return {
    nodeId: member.node.id,
    nodeName: member.node.name,
    kind: member.entry.kind,
    name: member.entry.name,
  };
}

const troubled = (member: ServiceMember) => member.entry.state !== "running";

export function groupByServer(
  data: ServicesResponse,
  nodes: NodeRecord[],
  options: { showSystem: boolean; query: string; notRunning: boolean },
): ServerGroup[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const latest = new Map<string, ActionRecord>();
  for (const action of data.actions) {
    latest.set(`${action.nodeId}|${action.kind}:${action.name}`, action);
  }
  const query = options.query.trim().toLowerCase();
  const groups: ServerGroup[] = [];
  for (const inventory of data.nodes) {
    const node = byId.get(inventory.id);
    if (!node) continue;
    const serverMatch = !query || node.name.toLowerCase().includes(query);
    const members = inventory.services
      .filter(
        (entry) =>
          (options.showSystem || !entry.system) &&
          (serverMatch ||
            displayName(entry.kind, entry.name).toLowerCase().includes(query)),
      )
      .map((entry) => ({
        node,
        entry,
        action: latest.get(`${node.id}|${entry.kind}:${entry.name}`) ?? null,
      }))
      .filter((member) => !options.notRunning || troubled(member))
      .sort(
        (a, b) =>
          Number(troubled(b)) - Number(troubled(a)) ||
          displayName(a.entry.kind, a.entry.name).localeCompare(
            displayName(b.entry.kind, b.entry.name),
          ),
      );
    if (members.length === 0) continue;
    groups.push({
      node,
      trusted: (inventory.trust?.keys.length ?? 0) > 0,
      members,
    });
  }
  const hurt = (group: ServerGroup) => group.members.some(troubled);
  return groups.sort(
    (a, b) =>
      Number(hurt(b)) - Number(hurt(a)) ||
      a.node.name.localeCompare(b.node.name),
  );
}

export function actionText(action: ActionRecord, nodeName: string): string {
  const words = WORDS[action.action];
  switch (action.status) {
    case "queued":
      return action.deliverableAt
        ? `Waiting for ${nodeName}`
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

export function durationText(action: ActionRecord): string | null {
  if (!action.sentAt || !action.finishedAt) return null;
  const seconds =
    (parseTimestamp(action.finishedAt) - parseTimestamp(action.sentAt)) / 1_000;
  return `${Math.max(1, Math.round(seconds))}s`;
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
      text:
        action.kind === "host"
          ? `${nodeName} ${words.done.toLowerCase()}`
          : `${name} ${words.done.toLowerCase()} on ${nodeName}`,
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
