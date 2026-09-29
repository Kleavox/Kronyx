import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch } from "./http";

function capture(status = 200, payload: unknown = { ok: true }) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

function contentType(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.["content-type"];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("declares JSON on a mutation that carries no body", async () => {
    const calls = capture();
    await apiFetch("/api/sessions/abc", { method: "DELETE" });
    expect(contentType(calls[0]!.init)).toBe("application/json");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "declares JSON on a bodyless %s",
    async (method) => {
      const calls = capture();
      await apiFetch("/api/thing", { method });
      expect(contentType(calls[0]!.init)).toBe("application/json");
    },
  );

  it("leaves a plain read without a content type", async () => {
    const calls = capture();
    await apiFetch("/api/session");
    expect(contentType(calls[0]!.init)).toBeUndefined();
  });

  it("lets an explicit header win", async () => {
    const calls = capture();
    await apiFetch("/api/thing", {
      method: "POST",
      headers: { "content-type": "text/plain" },
    });
    expect(contentType(calls[0]!.init)).toBe("text/plain");
  });

  it("raises the server's message and code", async () => {
    capture(415, {
      code: "unsupported_media_type",
      message: "Use application/json.",
    });
    await expect(apiFetch("/api/thing", { method: "DELETE" })).rejects.toThrow(
      ApiError,
    );
  });

  it("carries any extra fields the server sent alongside the error", async () => {
    capture(401, {
      code: "invalid_code",
      message: "That code is incorrect.",
      attemptsLeft: 3,
    });
    await expect(apiFetch("/api/thing")).rejects.toMatchObject({
      details: {
        code: "invalid_code",
        message: "That code is incorrect.",
        attemptsLeft: 3,
      },
    });
  });

  it("carries exactly the payload the server sent, inventing no extra keys", async () => {
    capture(500, { code: "internal_error", message: "Something broke." });
    const error = await apiFetch("/api/thing").catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).details).toEqual({
      code: "internal_error",
      message: "Something broke.",
    });
  });
});
