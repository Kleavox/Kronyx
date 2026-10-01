import { describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { sendDigestEmail, sendServerEmail } from "./mail";

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

const at = "2026-09-28T08:05:09.123Z";
const down = (checkName: string, summary = `${checkName} is down`) => ({
  checkName,
  summary,
  occurredAt: at,
});

describe("incident email", () => {
  it("goes to the operator through the Cloudflare binding, one mail per server", async () => {
    const { env, sent } = mailEnv();
    await sendServerEmail(env, {
      nodeName: "pivox",
      down: [
        down("API <health>", "API <health> is down: timeout"),
        down("Web"),
      ],
      up: [],
    });
    const message = sent();
    expect(message.to).toBe("operator@example.test");
    expect(message.from).toEqual({
      name: "Krynodes",
      email: "kry@example.test",
    });
    expect(message.subject).toBe(
      "[Krynodes] pivox: 2 checks down — API <health>, Web",
    );
    expect(message.html).toContain("API &lt;health&gt;");
    expect(message.html).not.toContain("<health>");
    expect(message.html).toContain("2026-09-28 08:05 UTC");
    expect(message.html).toContain('href="https://kry.example.test/incidents"');
    expect(message.html).not.toMatch(/Pulse|Kleavox/u);
    expect(message.text).toContain("timeout");
    expect(message.text).toContain("https://kry.example.test/incidents");
  });

  it("says when checks are back up, alone or next to new failures", async () => {
    const { env, send } = mailEnv();
    await sendServerEmail(env, {
      nodeName: "pivox",
      down: [],
      up: [down("API")],
    });
    await sendServerEmail(env, {
      nodeName: "pivox",
      down: [down("Web")],
      up: [down("API"), down("Health")],
    });
    const subjects = (
      send.mock.calls as unknown as [Record<string, string>][]
    ).map(([message]) => message.subject);
    expect(subjects).toEqual([
      "[Krynodes] pivox: check back up — API",
      "[Krynodes] pivox: 1 check down — Web · back up — API, Health",
    ]);
  });

  it("sums up what was held back", async () => {
    const { env, sent } = mailEnv();
    await sendDigestEmail(env, { count: 4, since: Date.parse(at) });
    expect(sent().subject).toBe("[Krynodes] 4 more check changes");
    expect(sent().text).toContain("2026-09-28 08:05 UTC");
  });

  it("sends nothing when no operator address or binding is configured", async () => {
    for (const extra of [{ ALERT_EMAIL: undefined }, { EMAIL: undefined }]) {
      const { env, send } = mailEnv(extra);
      await sendServerEmail(env, {
        nodeName: "pivox",
        down: [down("API")],
        up: [],
      });
      expect(send).not.toHaveBeenCalled();
    }
  });
});
