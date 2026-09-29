const DAY = 86_400_000;
const WINDOW_DAYS = 90;
const INCIDENT_DAYS = 30;
const STALE_MS = 180_000;
const SLOT_MS = 30 * 60_000;
const SLOTS = 48;

export type ServiceState = "up" | "down" | "nodata";
type DayState = "up" | "partial" | "down" | "none";
type SlotState = "up" | "partial" | "down" | "nodata" | "none";

export interface DayBar {
  start: number;
  state: DayState;
  downMs: number;
}

export interface SlotBar {
  start: number;
  state: SlotState;
  up: number;
  down: number;
}

export interface RecentInfo {
  since: number;
  up: number;
  total: number;
  lastDown: number | null;
}

export interface LongInfo {
  since: number;
  incidents: number;
  downMs: number;
  lastDown: number | null;
}

export interface Service {
  name: string;
  note: string | null;
  state: ServiceState;
  uptime: number | null;
  latencyMs: number | null;
  days: DayBar[];
  recent: SlotBar[];
  recentUptime: number | null;
  recentInfo: RecentInfo;
  longInfo: LongInfo;
}

interface PublicIncident {
  name: string;
  startedAt: number;
  resolvedAt: number | null;
}

export interface StatusView {
  services: Service[];
  incidents: PublicIncident[];
}

interface Span {
  start: number;
  end: number;
}

interface Result {
  at: number;
  status: "UP" | "DOWN";
}

interface CheckRow {
  id: string;
  name: string;
  public_note: string | null;
  status: string;
  last_seen_at: string | null;
  created_at: string;
  latency_ms: number | null;
}

interface IncidentRow {
  check_id: string;
  started_at: string;
  resolved_at: string | null;
}

interface ResultRow {
  check_id: string;
  status: "UP" | "DOWN";
  checked_at: string;
}

function toMs(value: string): number {
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value,
  );
}

function overlap(span: Span, from: number, to: number): number {
  return Math.max(0, Math.min(span.end, to) - Math.max(span.start, from));
}

function touches(span: Span, from: number, to: number): boolean {
  return span.start < to && (span.end > from || span.start >= from);
}

function windowStart(now: number): number {
  return Math.floor(now / DAY) * DAY - (WINDOW_DAYS - 1) * DAY;
}

export function dayBars(
  spans: Span[],
  createdAt: number,
  now: number,
): DayBar[] {
  const first = windowStart(now);
  return Array.from({ length: WINDOW_DAYS }, (_, index) => {
    const start = first + index * DAY;
    const end = Math.min(start + DAY, now);
    if (start + DAY <= createdAt) return { start, state: "none", downMs: 0 };
    const hit = spans.filter((span) => touches(span, start, end));
    const downMs = hit.reduce(
      (sum, span) => sum + overlap(span, start, end),
      0,
    );
    const monitored = end - Math.max(start, createdAt);
    return {
      start,
      state:
        hit.length === 0 ? "up" : downMs * 2 > monitored ? "down" : "partial",
      downMs,
    };
  });
}

export function uptime(
  spans: Span[],
  createdAt: number,
  now: number,
): number | null {
  const from = Math.max(windowStart(now), createdAt);
  if (now <= from) return null;
  const down = spans.reduce((sum, span) => sum + overlap(span, from, now), 0);
  return (1 - down / (now - from)) * 100;
}

export function longInfo(
  spans: Span[],
  createdAt: number,
  now: number,
): LongInfo {
  const since = Math.max(windowStart(now), createdAt);
  const seen = spans.filter((span) => touches(span, since, now));
  return {
    since,
    incidents: seen.length,
    downMs: seen.reduce((sum, span) => sum + overlap(span, since, now), 0),
    lastDown:
      seen.length > 0 ? Math.max(...seen.map((span) => span.start)) : null,
  };
}

export function recentBars(
  results: Result[],
  createdAt: number,
  now: number,
): SlotBar[] {
  const inSlot = (start: number) =>
    results.filter(
      (result) => result.at >= start && result.at < start + SLOT_MS,
    );
  const current = Math.floor(now / SLOT_MS) * SLOT_MS;
  const last = inSlot(current).length > 0 ? current : current - SLOT_MS;
  return Array.from({ length: SLOTS }, (_, index) => {
    const start = last - (SLOTS - 1 - index) * SLOT_MS;
    if (start + SLOT_MS <= createdAt) {
      return { start, state: "none", up: 0, down: 0 };
    }
    const hit = inSlot(start);
    const down = hit.filter((result) => result.status === "DOWN").length;
    const up = hit.length - down;
    return {
      start,
      state:
        down * 2 > up + down
          ? "down"
          : down > 0
            ? "partial"
            : up > 0
              ? "up"
              : "nodata",
      up,
      down,
    };
  });
}

export function recentInfo(results: Result[], since: number): RecentInfo {
  const counted = results.filter((result) => result.at >= since);
  const down = counted
    .filter((result) => result.status === "DOWN")
    .map((result) => result.at);
  return {
    since,
    up: counted.length - down.length,
    total: counted.length,
    lastDown: down.length > 0 ? Math.max(...down) : null,
  };
}

export function serviceState(
  status: string,
  lastSeenAt: string | null,
  now: number,
): ServiceState {
  if (!lastSeenAt || now - toMs(lastSeenAt) > STALE_MS) return "nodata";
  if (status === "UP") return "up";
  return status === "DOWN" ? "down" : "nodata";
}

export async function statusVersion(db: D1Database): Promise<string> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count, MAX(updated_at) AS changed FROM checks WHERE public = 1",
    )
    .first<{ count: number; changed: string | null }>();
  return `${row?.count ?? 0}:${row?.changed ?? ""}`;
}

export async function loadStatus(
  db: D1Database,
  now: number,
): Promise<StatusView> {
  const since = new Date(windowStart(now)).toISOString();
  const recentSince = new Date(
    (Math.floor(now / SLOT_MS) - SLOTS) * SLOT_MS,
  ).toISOString();
  const [checks, incidents, results] = await Promise.all([
    db
      .prepare(
        `SELECT c.id, c.name, c.public_note, c.status, n.last_seen_at, c.created_at,
                (SELECT r.latency_ms FROM check_results r
                 WHERE r.check_id = c.id
                 ORDER BY r.checked_at DESC LIMIT 1) AS latency_ms
         FROM checks c LEFT JOIN nodes n ON n.id = c.node_id
         WHERE c.public = 1 AND c.enabled = 1 ORDER BY c.name`,
      )
      .all<CheckRow>(),
    db
      .prepare(
        `SELECT i.check_id, i.started_at, i.resolved_at
         FROM incidents i
         WHERE i.check_id IN (SELECT id FROM checks WHERE public = 1 AND enabled = 1)
           AND (i.resolved_at IS NULL OR datetime(i.resolved_at) >= datetime(?))`,
      )
      .bind(since)
      .all<IncidentRow>(),
    db
      .prepare(
        `SELECT check_id, status, checked_at
         FROM check_results
         WHERE check_id IN (SELECT id FROM checks WHERE public = 1 AND enabled = 1)
           AND checked_at >= ?`,
      )
      .bind(recentSince)
      .all<ResultRow>(),
  ]);

  const spans = new Map<string, Span[]>();
  for (const row of incidents.results) {
    const start = toMs(row.started_at);
    const end = row.resolved_at ? Math.max(start, toMs(row.resolved_at)) : now;
    spans.set(row.check_id, [
      ...(spans.get(row.check_id) ?? []),
      { start, end },
    ]);
  }
  const outcomes = new Map<string, Result[]>();
  for (const row of results.results) {
    outcomes.set(row.check_id, [
      ...(outcomes.get(row.check_id) ?? []),
      { at: toMs(row.checked_at), status: row.status },
    ]);
  }
  const names = new Map(checks.results.map((row) => [row.id, row.name]));

  return {
    services: checks.results.map((row) => {
      const own = spans.get(row.id) ?? [];
      const reports = outcomes.get(row.id) ?? [];
      const createdAt = toMs(row.created_at);
      const recent = recentBars(reports, createdAt, now);
      const info = recentInfo(reports, Math.max(recent[0]!.start, createdAt));
      return {
        name: row.name,
        note: row.public_note,
        state: serviceState(row.status, row.last_seen_at, now),
        uptime: uptime(own, createdAt, now),
        latencyMs: row.latency_ms,
        days: dayBars(own, createdAt, now),
        recent,
        recentUptime: info.total > 0 ? (info.up / info.total) * 100 : null,
        recentInfo: info,
        longInfo: longInfo(own, createdAt, now),
      };
    }),
    incidents: incidents.results
      .filter(
        (row) =>
          row.resolved_at === null ||
          toMs(row.started_at) >= now - INCIDENT_DAYS * DAY,
      )
      .map((row) => ({
        name: names.get(row.check_id) ?? "",
        startedAt: toMs(row.started_at),
        resolvedAt: row.resolved_at ? toMs(row.resolved_at) : null,
      }))
      .sort((a, b) => b.startedAt - a.startedAt),
  };
}
