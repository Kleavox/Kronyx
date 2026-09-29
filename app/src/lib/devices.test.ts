import { describe, expect, it } from "vitest";

import type { DeviceRecord, NodeRecord, NodeTrust } from "../types";
import {
  fingerprint,
  initialChanges,
  nextVersion,
  proposal,
  signersFor,
  trustChange,
  trustedDeviceIds,
  trustSummary,
} from "./devices";

const T = Date.parse("2026-09-29T10:00:00.000Z");
const ORIGIN = "https://kry.example.test";

const node = (id: string, agent = "0.2.0") =>
  ({
    id,
    name: id,
    agent_version: agent,
    enrolled_at: "2026-09-29 09:00:00",
    disabled_at: null,
  }) as NodeRecord;

const device = (id: string, publicKey = "AQID"): DeviceRecord => ({
  id,
  name: id,
  alg: -7,
  publicKey,
  createdAt: "2026-09-29T09:00:00.000Z",
  lastUsedAt: null,
});

describe("deploy devices", () => {
  it("fingerprints a key the way the agent does", async () => {
    expect(await fingerprint("AQID")).toBe("039058c6f2c0cb49");
  });

  it("sorts every server into trusted, empty, stale or too old", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d", "0.1.1")];
    const trust: Record<string, NodeTrust | null> = {
      a: { version: 2, keys: ["1111111111111111"] },
      b: { version: 2, keys: ["1111111111111111", "2222222222222222"] },
      c: null,
      d: null,
    };
    const summary = trustSummary(nodes, trust, ["1111111111111111"]);
    expect(summary.total).toBe(4);
    expect(summary.trusted.map((item) => item.id)).toEqual(["a"]);
    expect(summary.stale.map((item) => item.id)).toEqual(["b"]);
    expect(summary.needsTrust.map((item) => item.id)).toEqual(["c"]);
    expect(summary.needsUpdate.map((item) => item.id)).toEqual(["d"]);
  });

  it("treats an empty store reported as version 0 like no store", () => {
    const summary = trustSummary([node("a")], { a: { version: 0, keys: [] } }, [
      "1111111111111111",
    ]);
    expect(summary.needsTrust.map((item) => item.id)).toEqual(["a"]);
  });

  it("the next version beats every server", () => {
    expect(
      nextVersion({
        a: { version: 2, keys: [] },
        b: { version: 5, keys: [] },
        c: null,
      }),
    ).toBe(6);
    expect(nextVersion({})).toBe(2);
  });

  it("builds one unsigned change per empty server", () => {
    const changes = initialChanges(["n1", "n2"], [device("d1")], ORIGIN, T);
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual({
      v: 1,
      nodeIds: ["n2"],
      origin: ORIGIN,
      rpId: "kry.example.test",
      version: 1,
      keys: [{ id: "d1", name: "d1", alg: -7, publicKey: "AQID" }],
      issuedAt: new Date(T).toISOString(),
      expiresAt: new Date(T + 10 * 60_000).toISOString(),
    });
  });

  it("builds one signed change for many servers", () => {
    expect(
      trustChange(
        ["n1", "n2"],
        [device("d1"), device("d2", "BAUG")],
        ORIGIN,
        3,
        T,
      ),
    ).toMatchObject({
      nodeIds: ["n1", "n2"],
      version: 3,
      keys: [{ id: "d1" }, { id: "d2" }],
    });
  });

  it("signs changes only with devices some server already trusts", () => {
    expect(
      trustedDeviceIds(
        [device("laptop"), device("phone")],
        ["1111111111111111", "2222222222222222"],
        { a: { version: 2, keys: ["1111111111111111"] }, b: null },
      ),
    ).toEqual(["laptop"]);
  });

  it("opens a deploy session only with devices every target server trusts", () => {
    const devices = [device("laptop"), device("phone"), device("tablet")];
    const prints = ["1111111111111111", "2222222222222222", "3333333333333333"];
    expect(
      signersFor(devices, prints, [
        ["1111111111111111", "2222222222222222"],
        ["2222222222222222", "3333333333333333"],
      ]),
    ).toEqual(["phone"]);
    expect(signersFor(devices, prints, [["9999999999999999"]])).toEqual([]);
  });

  it("proposes the trusted devices plus the new one, never every stored row", () => {
    const devices = [device("laptop"), device("stray"), device("phone")];
    const added = proposal(devices, ["laptop"], { add: "phone" });
    expect(added.keys.map((item) => item.id)).toEqual(["laptop", "phone"]);
    expect(added.added).toEqual(["phone"]);
    expect(added.removed).toEqual([]);
    const removed = proposal(devices, ["laptop", "phone"], { remove: "phone" });
    expect(removed.keys.map((item) => item.id)).toEqual(["laptop"]);
    expect(removed.removed).toEqual(["phone"]);
    const synced = proposal(devices, ["laptop"], {});
    expect(synced.keys.map((item) => item.id)).toEqual([
      "laptop",
      "stray",
      "phone",
    ]);
    expect(synced.added).toEqual(["stray", "phone"]);
  });
});
