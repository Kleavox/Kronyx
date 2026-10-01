const RELEASES = "https://github.com/Kleavox/Krynodes/releases";
const VERSION = /^\d+\.\d+\.\d+$/u;

export interface AgentRelease {
  version: string | null;
  checkedAt: string | null;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function canUpdateRemotely(agentVersion: string | null): boolean {
  return agentVersion !== null && VERSION.test(agentVersion);
}

export function parseReleaseLocation(location: string | null): string | null {
  const match = location?.match(/\/releases\/tag\/agent-v(\d+\.\d+\.\d+)$/u);
  return match?.[1] ?? null;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${RELEASES}/latest`, {
      redirect: "manual",
      headers: { "user-agent": "kry-worker" },
    });
    return parseReleaseLocation(response.headers.get("location"));
  } catch {
    return null;
  }
}

export async function readAgentRelease(db: D1Database): Promise<AgentRelease> {
  const row = await db
    .prepare(
      "SELECT value, updated_at FROM settings WHERE key = 'agent_release'",
    )
    .first<{ value: string | null; updated_at: string }>();
  return { version: row?.value ?? null, checkedAt: row?.updated_at ?? null };
}

export async function checkAgentRelease(
  db: D1Database,
  now = Date.now(),
): Promise<AgentRelease> {
  const found = await fetchLatestVersion();
  const version = found ?? (await readAgentRelease(db)).version;
  const checkedAt = new Date(now).toISOString();
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('agent_release', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(version, checkedAt)
    .run();
  return { version, checkedAt };
}

export async function requestAutoUpdates(
  db: D1Database,
  version: string,
  now = Date.now(),
): Promise<number> {
  const candidates = await db
    .prepare(
      `SELECT id, agent_version FROM nodes
       WHERE auto_update = 1 AND enrolled_at IS NOT NULL
         AND disabled_at IS NULL AND update_requested_version IS NULL`,
    )
    .all<{ id: string; agent_version: string | null }>();
  const due = candidates.results.filter(
    (node) =>
      canUpdateRemotely(node.agent_version) &&
      compareVersions(node.agent_version!, version) < 0,
  );
  if (due.length === 0) return 0;
  const requestedAt = new Date(now).toISOString();
  await db.batch(
    due.map((node) =>
      db
        .prepare(
          `UPDATE nodes SET update_requested_version = ?, update_requested_at = ?,
             update_attempts = 1, update_error = NULL
           WHERE id = ?`,
        )
        .bind(version, requestedAt, node.id),
    ),
  );
  return due.length;
}

export async function runReleaseCheck(db: D1Database): Promise<void> {
  const { version } = await checkAgentRelease(db);
  if (version) await requestAutoUpdates(db, version);
}
