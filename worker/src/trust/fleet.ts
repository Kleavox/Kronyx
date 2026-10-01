import { compareVersions } from "../agent/releases";
import { fingerprint } from "../lib/webauthn";

const QUORUM_SINCE = "0.3.0";
const UV_SINCE = "0.3.1";

export interface TrustReport {
  version: number;
  core: string[];
  access: string[];
  passphrase: boolean;
  requireUv: boolean;
}

interface FleetDevice {
  id: string;
  name: string;
  alg: number;
  publicKey: string;
  createdAt: string;
  lastUsedAt: string | null;
  removedAt: string | null;
  verifies: boolean | null;
  fingerprint: string;
}

export interface FleetNode {
  id: string;
  name: string;
  agentVersion: string | null;
  report: TrustReport | null;
}

interface PassphraseRecord {
  salt: string;
  iterations: number;
  publicKey: string;
}

export interface Fleet {
  devices: FleetDevice[];
  nodes: FleetNode[];
  core: string[];
  passphrase: PassphraseRecord | null;
  requireUv: boolean;
  ids: (prints: string[]) => string[];
}

export function readReport(text: string | null): TrustReport | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<TrustReport> & {
      keys?: string[];
    };
    if (Array.isArray(parsed.keys)) {
      return {
        version: parsed.version ?? 0,
        core: parsed.keys,
        access: parsed.keys,
        passphrase: false,
        requireUv: false,
      };
    }
    return {
      version: parsed.version ?? 0,
      core: parsed.core ?? [],
      access: parsed.access ?? [],
      passphrase: parsed.passphrase ?? false,
      requireUv: parsed.requireUv ?? false,
    };
  } catch {
    return null;
  }
}

const atLeast = (node: FleetNode, since: string) =>
  node.agentVersion !== null &&
  /^\d+\.\d+\.\d+$/u.test(node.agentVersion) &&
  compareVersions(node.agentVersion, since) >= 0;

export const speaksQuorum = (node: FleetNode) => atLeast(node, QUORUM_SINCE);

export const speaksUv = (node: FleetNode) => atLeast(node, UV_SINCE);

export async function loadFleet(
  db: D1Database,
  ownerId: string,
): Promise<Fleet> {
  const [devices, nodes, passphrase] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, alg, public_key, created_at, last_used_at, removed_at, verifies
         FROM devices WHERE owner_user_id = ? ORDER BY created_at, id`,
      )
      .bind(ownerId)
      .all<{
        id: string;
        name: string;
        alg: number;
        public_key: string;
        created_at: string;
        last_used_at: string | null;
        removed_at: string | null;
        verifies: number | null;
      }>(),
    db
      .prepare(
        `SELECT id, name, agent_version, trust_report FROM nodes
         WHERE owner_user_id = ? AND enrolled_at IS NOT NULL AND disabled_at IS NULL
         ORDER BY name, id`,
      )
      .bind(ownerId)
      .all<{
        id: string;
        name: string;
        agent_version: string | null;
        trust_report: string | null;
      }>(),
    db
      .prepare(
        "SELECT salt, iterations, public_key FROM passphrase WHERE owner_user_id = ?",
      )
      .bind(ownerId)
      .first<{ salt: string; iterations: number; public_key: string }>(),
  ]);
  const listed = await Promise.all(
    devices.results.map(async (row) => ({
      id: row.id,
      name: row.name,
      alg: row.alg,
      publicKey: row.public_key,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      removedAt: row.removed_at,
      verifies: row.verifies === null ? null : row.verifies === 1,
      fingerprint: await fingerprint(row.public_key),
    })),
  );
  const listedNodes = nodes.results.map((row) => ({
    id: row.id,
    name: row.name,
    agentVersion: row.agent_version,
    report: readReport(row.trust_report),
  }));
  const ids = (prints: string[]) =>
    listed
      .filter((device) => prints.includes(device.fingerprint))
      .map((device) => device.id);
  const union = new Set(listedNodes.flatMap((node) => node.report?.core ?? []));
  return {
    devices: listed,
    nodes: listedNodes,
    core: ids([...union]),
    passphrase: passphrase
      ? {
          salt: passphrase.salt,
          iterations: passphrase.iterations,
          publicKey: passphrase.public_key,
        }
      : null,
    requireUv: listedNodes.some((node) => node.report?.requireUv),
    ids,
  };
}
