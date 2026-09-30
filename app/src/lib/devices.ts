import type { DeviceRecord, NodeRecord, NodeTrust } from "../types";
import { compareVersions } from "./agent";
import { fromB64url, TRUST_CHANGE_MS } from "./passkeys";

export const DEPLOY_SINCE = "0.2.0";
const VERSION = /^\d+\.\d+\.\d+$/u;

export interface TrustSummary {
  total: number;
  trusted: NodeRecord[];
  stale: NodeRecord[];
  needsTrust: NodeRecord[];
  needsUpdate: NodeRecord[];
}

export async function fingerprint(publicKey: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", fromB64url(publicKey)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

const RESTART_SINCE = "0.2.2";

const atLeast = (version: string | null, since: string) =>
  version !== null &&
  VERSION.test(version) &&
  compareVersions(version, since) >= 0;

export function canDeploy(node: Pick<NodeRecord, "agent_version">): boolean {
  return atLeast(node.agent_version, DEPLOY_SINCE);
}

export function canRestartServer(
  node: Pick<NodeRecord, "agent_version">,
  trust: NodeTrust | null,
): boolean {
  return (
    atLeast(node.agent_version, RESTART_SINCE) && (trust?.keys.length ?? 0) > 0
  );
}

const sameKeys = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function trustSummary(
  nodes: NodeRecord[],
  trust: Record<string, NodeTrust | null>,
  fingerprints: string[],
): TrustSummary {
  const summary: TrustSummary = {
    total: nodes.length,
    trusted: [],
    stale: [],
    needsTrust: [],
    needsUpdate: [],
  };
  for (const node of nodes) {
    const report = trust[node.id] ?? null;
    if (!canDeploy(node)) summary.needsUpdate.push(node);
    else if (!report || report.keys.length === 0) summary.needsTrust.push(node);
    else if (sameKeys(report.keys, fingerprints)) summary.trusted.push(node);
    else summary.stale.push(node);
  }
  return summary;
}

export function trustedDeviceIds(
  devices: DeviceRecord[],
  fingerprints: string[],
  trust: Record<string, NodeTrust | null>,
): string[] {
  const known = new Set(
    Object.values(trust).flatMap((report) => report?.keys ?? []),
  );
  return devices
    .filter((_, index) => known.has(fingerprints[index] ?? ""))
    .map((device) => device.id);
}

export function signersFor(
  devices: DeviceRecord[],
  fingerprints: string[],
  targetKeys: string[][],
): string[] {
  return devices
    .filter(
      (_, index) =>
        targetKeys.length > 0 &&
        targetKeys.every((keys) => keys.includes(fingerprints[index] ?? "")),
    )
    .map((device) => device.id);
}

export interface Proposal {
  keys: DeviceRecord[];
  added: string[];
  removed: string[];
}

export function proposal(
  devices: DeviceRecord[],
  trustedIds: string[],
  change: { add?: string; remove?: string },
): Proposal {
  if (!change.add && !change.remove) {
    return {
      keys: devices,
      added: devices
        .filter((device) => !trustedIds.includes(device.id))
        .map((device) => device.id),
      removed: [],
    };
  }
  return {
    keys: devices.filter(
      (device) =>
        device.id === change.add ||
        (trustedIds.includes(device.id) && device.id !== change.remove),
    ),
    added: change.add ? [change.add] : [],
    removed: change.remove ? [change.remove] : [],
  };
}

export function nextVersion(trust: Record<string, NodeTrust | null>): number {
  const versions = Object.values(trust).map((report) => report?.version ?? 1);
  return Math.max(1, ...versions) + 1;
}

function change(
  nodeIds: string[],
  devices: DeviceRecord[],
  origin: string,
  version: number,
  now: number,
) {
  return {
    v: 1,
    nodeIds,
    origin,
    rpId: new URL(origin).hostname,
    version,
    keys: devices.map(({ id, name, alg, publicKey }) => ({
      id,
      name,
      alg,
      publicKey,
    })),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TRUST_CHANGE_MS).toISOString(),
  };
}

export function initialChanges(
  nodeIds: string[],
  devices: DeviceRecord[],
  origin: string,
  now = Date.now(),
) {
  return nodeIds.map((id) => change([id], devices, origin, 1, now));
}

export function trustChange(
  nodeIds: string[],
  devices: DeviceRecord[],
  origin: string,
  version: number,
  now = Date.now(),
) {
  return change(nodeIds, devices, origin, version, now);
}
