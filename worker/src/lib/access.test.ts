import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ACCESS_AUD,
  ACCESS_TEAM,
  accessClaims,
  accessKeys,
  serveAccessCerts,
  signAccessToken,
} from "../test/access-token";
import { verifyAccessToken } from "./access";

const NOW = Date.parse("2026-09-28T08:00:00Z");
const config = { teamDomain: ACCESS_TEAM, audience: ACCESS_AUD };

let keys: Awaited<ReturnType<typeof accessKeys>>;
const sign = (extra: Record<string, unknown> = {}, kid?: string) =>
  signAccessToken(keys.privateKey, accessClaims(NOW, extra), kid);

function request(token?: string) {
  return new Request("https://kry.example.test/api/overview", {
    headers: token ? { "cf-access-jwt-assertion": token } : {},
  });
}

beforeAll(async () => {
  keys = await accessKeys();
});

afterEach(() => vi.unstubAllGlobals());

describe("verifyAccessToken", () => {
  it("accepts a token Access signed for this application", async () => {
    const fetch = serveAccessCerts(keys.jwk);
    expect(await verifyAccessToken(request(await sign()), config, NOW)).toEqual(
      { email: "operator@example.test" },
    );
    expect(fetch).toHaveBeenCalledWith(
      `https://${ACCESS_TEAM}/cdn-cgi/access/certs`,
    );
  });

  it("refuses a request that did not come through Access", async () => {
    serveAccessCerts(keys.jwk);
    expect(await verifyAccessToken(request(), config, NOW)).toBeNull();
    expect(
      await verifyAccessToken(request("not-a-jwt"), config, NOW),
    ).toBeNull();
  });

  it("refuses a token for another application or issuer", async () => {
    serveAccessCerts(keys.jwk);
    for (const extra of [
      { aud: ["someone-else"] },
      { iss: "https://evil.cloudflareaccess.com" },
    ]) {
      expect(
        await verifyAccessToken(request(await sign(extra)), config, NOW),
      ).toBeNull();
    }
  });

  it("refuses an expired or not-yet-valid token", async () => {
    serveAccessCerts(keys.jwk);
    for (const extra of [{ exp: NOW / 1000 - 1 }, { nbf: NOW / 1000 + 60 }]) {
      expect(
        await verifyAccessToken(request(await sign(extra)), config, NOW),
      ).toBeNull();
    }
  });

  it("refuses a token signed by any other key", async () => {
    serveAccessCerts(keys.jwk);
    const other = await accessKeys();
    expect(
      await verifyAccessToken(
        request(await signAccessToken(other.privateKey, accessClaims(NOW))),
        config,
        NOW,
      ),
    ).toBeNull();
    expect(
      await verifyAccessToken(request(await sign({}, "unknown")), config, NOW),
    ).toBeNull();
  });
});
