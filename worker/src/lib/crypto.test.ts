import { describe, expect, it } from "vitest";

import { randomToken, readBearerToken, sha256 } from "./crypto";

describe("Krynodes agent credentials", () => {
  it("creates URL-safe high-entropy tokens", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("hashes credentials deterministically", async () => {
    await expect(sha256("credential")).resolves.toHaveLength(64);
    await expect(sha256("credential")).resolves.toBe(
      await sha256("credential"),
    );
  });

  it("reads only bearer credentials", () => {
    expect(readBearerToken("Bearer secret")).toBe("secret");
    expect(readBearerToken("Basic secret")).toBeNull();
  });
});
