import { afterEach, describe, expect, it, vi } from "vitest";

const openSession = vi.fn();
const signIntent = vi.fn();

vi.mock("./deploy-session", () => ({ openSession }));
vi.mock("./passkeys", () => ({ signIntent }));

const { guardedFetch } = await import("./proof");

const NEEDED = {
  code: "PROOF_NEEDED",
  message: "Confirm with the passkey of a core device.",
  op: "node.delete",
  target: "n1",
  core: ["phone"],
  requireUv: true,
  passphrase: null,
};

function replies(...answers: [number, unknown][]) {
  const calls: RequestInit[] = [];
  vi.stubGlobal("window", { location: { origin: "https://kry.example.test" } });
  vi.stubGlobal("fetch", (_path: string, init: RequestInit) => {
    calls.push(init);
    const [status, body] = answers[calls.length - 1]!;
    return Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), { status }),
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  openSession.mockReset();
  signIntent.mockReset();
});

describe("guardedFetch", () => {
  it("asks for the passkey only when the Worker says so, then sends the proof", async () => {
    const calls = replies([403, NEEDED], [204, null]);
    openSession.mockResolvedValue({ grant: {} });
    signIntent.mockResolvedValue("signed-intent");
    await guardedFetch("/api/nodes/n1", { method: "DELETE" });
    expect(openSession).toHaveBeenCalledWith(["phone"], "fingerprint");
    expect(signIntent).toHaveBeenCalledWith(
      { grant: {} },
      "node.delete",
      "n1",
      "https://kry.example.test",
    );
    expect(calls).toHaveLength(2);
    expect((calls[1]!.headers as Record<string, string>)["x-kry-proof"]).toBe(
      "signed-intent",
    );
  });

  it("passes other refusals through without a prompt", async () => {
    const calls = replies([403, { code: "NOT_CORE", message: "No." }]);
    await expect(
      guardedFetch("/api/nodes/n1", { method: "DELETE" }),
    ).rejects.toThrow("No.");
    expect(openSession).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("explains a cancelled fingerprint", async () => {
    replies([403, NEEDED]);
    openSession.mockRejectedValue(
      new DOMException("cancelled", "NotAllowedError"),
    );
    await expect(
      guardedFetch("/api/nodes/n1", { method: "DELETE" }),
    ).rejects.toThrow(/No fingerprint was confirmed/u);
  });
});
