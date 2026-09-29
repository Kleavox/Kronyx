import { describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { sendIncidentEmail } from "./mail";

function mailEnv(extra: Partial<Env> = {}) {
  const send = vi.fn(async () => ({ messageId: "m-1" }));
  const env = {
    EMAIL: { send },
    ALERT_EMAIL: "operator@example.test",
    FROM_EMAIL: "kry@example.test",
    PUBLIC_ORIGIN: "https://kry.example.test",
    ...extra,
  } as unknown as Env;
  const sent = () =>
    (send.mock.calls[0] as unknown as [Record<string, string>])[0];
  return { env, send, sent };
}

describe("incident email", () => {
  it("goes to the operator through the Cloudflare binding, with a text part", async () => {
    const { env, sent } = mailEnv();
    await sendIncidentEmail(env, {
      kind: "opened",
      checkName: "API <health>",
      nodeName: "pivox",
      summary: "API <health> is down: timeout",
      occurredAt: "2026-09-28T08:05:09.123Z",
    });
    const message = sent();
    expect(message.to).toBe("operator@example.test");
    expect(message.from).toEqual({
      name: "Krynodes",
      email: "kry@example.test",
    });
    expect(message.subject).toBe("[Krynodes] API <health> is down");
    expect(message.html).toContain("API &lt;health&gt; is down");
    expect(message.html).not.toContain("<health>");
    expect(message.html).toContain("2026-09-28 08:05 UTC");
    expect(message.html).toContain('href="https://kry.example.test/incidents"');
    expect(message.html).not.toMatch(/Pulse|Kleavox/u);
    expect(message.text).toContain("API <health> is down: timeout");
    expect(message.text).toContain("Node: pivox");
    expect(message.text).toContain("https://kry.example.test/incidents");
  });

  it("marks a recovery as resolved", async () => {
    const { env, sent } = mailEnv();
    await sendIncidentEmail(env, {
      kind: "resolved",
      checkName: "API",
      nodeName: "pivox",
      summary: "API is responding again.",
      occurredAt: "2026-09-28T09:00:00.000Z",
    });
    expect(sent().subject).toBe("[Krynodes] API recovered");
    expect(sent().html).toContain("Resolved");
  });

  it("sends nothing when no operator address or binding is configured", async () => {
    for (const extra of [{ ALERT_EMAIL: undefined }, { EMAIL: undefined }]) {
      const { env, send } = mailEnv(extra);
      await sendIncidentEmail(env, {
        kind: "opened",
        checkName: "API",
        nodeName: "pivox",
        summary: "API is down",
        occurredAt: "2026-09-28T09:00:00.000Z",
      });
      expect(send).not.toHaveBeenCalled();
    }
  });
});
