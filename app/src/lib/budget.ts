import type { CheckRecord, NodeRecord } from "../types";

const BUDGET = { writes: 30_000, requests: 20_000 } as const;

const DAY_SECONDS = 86_400;
const DASHBOARD_REQUESTS = 3_000;

interface DailyUse {
  writes: number;
  requests: number;
}

export function estimateDailyUse(
  nodes: Pick<
    NodeRecord,
    "id" | "interval_seconds" | "disabled_at" | "enrolled_at"
  >[],
  checks: Pick<CheckRecord, "node_id" | "enabled">[],
): DailyUse {
  let writes = 0;
  let requests = DASHBOARD_REQUESTS;
  const windowsPerDay = new Map<string, number>();
  for (const node of nodes) {
    if (node.disabled_at || !node.enrolled_at) continue;
    const cycles = DAY_SECONDS / node.interval_seconds;
    const windows = DAY_SECONDS / Math.max(300, node.interval_seconds);
    windowsPerDay.set(node.id, windows);
    writes += cycles + 4 * windows;
    requests += cycles;
  }
  for (const check of checks) {
    const windows = windowsPerDay.get(check.node_id);
    if (windows !== undefined && check.enabled) writes += 4 * windows;
  }
  return { writes: Math.round(writes), requests: Math.round(requests) };
}

export function budgetLevel(use: DailyUse): "ok" | "warn" | "over" {
  const ratio = Math.max(
    use.writes / BUDGET.writes,
    use.requests / BUDGET.requests,
  );
  if (ratio > 1) return "over";
  return ratio >= 0.8 ? "warn" : "ok";
}

const COMPACT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatThousands(value: number): string {
  return COMPACT.format(value).toLowerCase();
}

export function quotaLine(use: DailyUse): { percent: number; detail: string } {
  const writes = use.writes / BUDGET.writes;
  const requests = use.requests / BUDGET.requests;
  const [used, limit, unit] =
    writes >= requests
      ? [use.writes, BUDGET.writes, "writes"]
      : [use.requests, BUDGET.requests, "requests"];
  return {
    percent: Math.round(Math.max(writes, requests) * 100),
    detail: `${formatThousands(used)} of ${formatThousands(limit)} ${unit}`,
  };
}
