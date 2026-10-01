import { describe, expect, it } from "vitest";

import {
  BATCH_MS,
  drain,
  emptyBox,
  enqueue,
  nextAlarm,
  type IncidentNotice,
} from "./notify";

const T = Date.parse("2026-10-01T10:00:00.000Z");
const HOUR = 3_600_000;

const notice = (
  nodeId: string,
  checkName: string,
  kind: "opened" | "resolved",
): IncidentNotice => ({
  nodeId,
  checkName,
  kind,
  summary: kind === "opened" ? `${checkName} is down` : "",
  occurredAt: new Date(T).toISOString(),
});

describe("incident mail box", () => {
  it("waits 90 seconds, then sends one mail per server", () => {
    const box = enqueue(
      emptyBox(),
      [
        notice("pivox", "Health", "opened"),
        notice("pivox", "API", "opened"),
        notice("vps", "Web", "opened"),
      ],
      T,
    );
    expect(nextAlarm(box)).toBe(T + BATCH_MS);
    expect(drain(box, T + 10_000).send).toEqual([]);

    const { send, box: after } = drain(box, T + BATCH_MS);
    expect(send.map((server) => server.nodeId)).toEqual(["pivox", "vps"]);
    expect(send[0]!.down.map((entry) => entry.checkName)).toEqual([
      "Health",
      "API",
    ]);
    expect(after.queue).toEqual([]);
    expect(nextAlarm(after)).toBeNull();
  });

  it("keeps the first deadline when more changes arrive", () => {
    const first = enqueue(emptyBox(), [notice("pivox", "API", "opened")], T);
    const second = enqueue(
      first,
      [notice("pivox", "Health", "opened")],
      T + 60_000,
    );
    expect(nextAlarm(second)).toBe(T + BATCH_MS);
  });

  it("leaves out a check that went down and came back inside the wait", () => {
    const box = enqueue(
      emptyBox(),
      [
        notice("pivox", "API", "opened"),
        notice("pivox", "Health", "opened"),
        notice("pivox", "API", "resolved"),
      ],
      T,
    );
    const { send } = drain(box, T + BATCH_MS);
    expect(send).toHaveLength(1);
    expect(send[0]!.down.map((entry) => entry.checkName)).toEqual(["Health"]);
    expect(send[0]!.up).toEqual([]);

    const flap = enqueue(
      emptyBox(),
      [notice("pivox", "API", "opened"), notice("pivox", "API", "resolved")],
      T,
    );
    expect(drain(flap, T + BATCH_MS).send).toEqual([]);
  });

  it("sends 6 mails an hour, holds the rest, then one digest", () => {
    let box = emptyBox();
    let sent = 0;
    for (let index = 0; index < 8; index += 1) {
      const at = T + index * 2 * BATCH_MS;
      box = enqueue(box, [notice(`n${index}`, "API", "opened")], at);
      const result = drain(box, at + BATCH_MS);
      sent += result.send.length;
      box = result.box;
    }
    expect(sent).toBe(6);
    expect(box.held).toBe(2);
    const digestAt = T + BATCH_MS + HOUR;
    expect(nextAlarm(box)).toBe(digestAt);

    expect(drain(box, digestAt - 1).digest).toBeNull();
    const result = drain(box, digestAt);
    expect(result.digest).toEqual({
      count: 2,
      since: T + 12 * BATCH_MS + BATCH_MS,
    });
    expect(result.box.held).toBe(0);
    expect(nextAlarm(result.box)).toBeNull();
  });
});
