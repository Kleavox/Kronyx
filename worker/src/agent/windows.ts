import type { CheckResult } from "@krynodes/protocol";

type WindowResult =
  ["UP", number | null] | ["DOWN", number | null, string | null];

export type WindowChecks = Record<string, WindowResult>;

export interface ExpandedResult {
  t: string;
  status: "UP" | "DOWN";
  latencyMs: number | null;
  message: string | null;
}

export interface WindowRow {
  window_start: string;
  checks: string | null;
}

export const windowSize = (intervalSeconds: number) =>
  Math.max(300, intervalSeconds) * 1000;

function windowStartMs(now: number, intervalSeconds: number): number {
  const size = windowSize(intervalSeconds);
  return Math.floor(now / size) * size;
}

export const windowStart = (now: number, intervalSeconds: number) =>
  new Date(windowStartMs(now, intervalSeconds)).toISOString();

export const staleAfterMs = (
  transport: string,
  intervalSeconds: number,
  httpMs: number,
) =>
  transport === "stream"
    ? windowSize(intervalSeconds) + 2 * intervalSeconds * 1000
    : httpMs;

const toResult = (result: CheckResult): WindowResult =>
  result.status === "DOWN"
    ? ["DOWN", result.latencyMs ?? null, result.message ?? null]
    : ["UP", result.latencyMs ?? null];

export function mergeChecks(
  current: WindowChecks,
  results: CheckResult[],
): WindowChecks {
  let next = current;
  for (const result of results) {
    const stored = next[result.checkId];
    if (stored && (stored[0] === "DOWN" || result.status === "UP")) continue;
    next = { ...next, [result.checkId]: toResult(result) };
  }
  return next;
}

function isResult(value: unknown): value is WindowResult {
  if (!Array.isArray(value)) return false;
  const [status, latency, message] = value as unknown[];
  const latencyOk = latency === null || typeof latency === "number";
  if (status === "UP") return latencyOk;
  return (
    status === "DOWN" &&
    latencyOk &&
    (message === undefined || message === null || typeof message === "string")
  );
}

export function parseChecks(text: string | null): WindowChecks {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).filter(([, result]) => isResult(result)),
    ) as WindowChecks;
  } catch {
    return {};
  }
}

export function expandResults(
  rows: WindowRow[],
  known: Set<string>,
): Map<string, ExpandedResult[]> {
  const out = new Map<string, ExpandedResult[]>();
  for (const row of rows) {
    for (const [checkId, result] of Object.entries(parseChecks(row.checks))) {
      if (!known.has(checkId)) continue;
      const list = out.get(checkId) ?? [];
      list.push({
        t: row.window_start,
        status: result[0],
        latencyMs: result[1],
        message: result[0] === "DOWN" ? (result[2] ?? null) : null,
      });
      out.set(checkId, list);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.t.localeCompare(b.t));
  return out;
}
