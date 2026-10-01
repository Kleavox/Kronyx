export interface IncidentNotice {
  nodeId: string;
  checkName: string;
  kind: "opened" | "resolved";
  summary: string;
  occurredAt: string;
}

export interface ServerChanges {
  nodeId: string;
  down: IncidentNotice[];
  up: IncidentNotice[];
}

export interface MailBox {
  queue: IncidentNotice[];
  dueAt: number | null;
  sent: number[];
  held: number;
  heldSince: number | null;
}

export const BATCH_MS = 90_000;
const HOUR_MS = 3_600_000;
const PER_HOUR = 6;

export const emptyBox = (): MailBox => ({
  queue: [],
  dueAt: null,
  sent: [],
  held: 0,
  heldSince: null,
});

export function enqueue(
  box: MailBox,
  notices: IncidentNotice[],
  now: number,
): MailBox {
  return {
    ...box,
    queue: [...box.queue, ...notices],
    dueAt: box.dueAt ?? now + BATCH_MS,
  };
}

function settle(queue: IncidentNotice[]): ServerChanges[] {
  const byCheck = new Map<string, IncidentNotice[]>();
  for (const notice of queue) {
    const key = `${notice.nodeId}\n${notice.checkName}`;
    byCheck.set(key, [...(byCheck.get(key) ?? []), notice]);
  }
  const servers = new Map<string, ServerChanges>();
  for (const notices of byCheck.values()) {
    const first = notices[0]!;
    const last = notices.at(-1)!;
    if (first.kind !== last.kind) continue;
    const server = servers.get(last.nodeId) ?? {
      nodeId: last.nodeId,
      down: [],
      up: [],
    };
    (last.kind === "opened" ? server.down : server.up).push(
      last.kind === "opened" ? first : last,
    );
    servers.set(last.nodeId, server);
  }
  return [...servers.values()];
}

export function drain(
  box: MailBox,
  now: number,
): {
  send: ServerChanges[];
  digest: { count: number; since: number } | null;
  box: MailBox;
} {
  const sent = box.sent.filter((at) => now - at < HOUR_MS);
  let { held, heldSince } = box;
  let digest = null;
  if (held > 0 && sent.length < PER_HOUR) {
    digest = { count: held, since: heldSince ?? now };
    sent.push(now);
    held = 0;
    heldSince = null;
  }
  if (box.dueAt === null || box.dueAt > now) {
    return { send: [], digest, box: { ...box, sent, held, heldSince } };
  }
  const send: ServerChanges[] = [];
  for (const server of settle(box.queue)) {
    if (sent.length < PER_HOUR) {
      send.push(server);
      sent.push(now);
    } else {
      held += server.down.length + server.up.length;
      heldSince ??= now;
    }
  }
  return {
    send,
    digest,
    box: { queue: [], dueAt: null, sent, held, heldSince },
  };
}

export function nextAlarm(box: MailBox): number | null {
  const times = [
    ...(box.dueAt === null ? [] : [box.dueAt]),
    ...(box.held > 0 && box.sent.length > 0 ? [box.sent[0]! + HOUR_MS] : []),
  ];
  return times.length > 0 ? Math.min(...times) : null;
}
