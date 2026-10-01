import { describe, expect, it } from "vitest";

import type {
  DeviceRecord,
  NodeRecord,
  NodeTrust,
  PassphraseKey,
} from "../types";
import {
  accessChange,
  accessIds,
  admitChange,
  buildChange,
  canRestartServer,
  decodeChange,
  describeChange,
  fingerprint,
  fingerprintsRequired,
  firstTrusts,
  formatPrint,
  nextVersion,
  predictMissing,
  removeChange,
  requireUvChange,
  serverState,
  signersFor,
  syncChange,
  uvBlocker,
  type FleetView,
} from "./devices";

const T = Date.parse("2026-09-29T10:00:00.000Z");
const ORIGIN = "https://kry.example.test";
const N1 = "11111111-1111-4111-8111-111111111111";
const N2 = "22222222-2222-4222-8222-222222222222";
const N3 = "33333333-3333-4333-8333-333333333333";
const PASS: PassphraseKey = {
  salt: "AAECAwQFBgcICQoLDA0ODw",
  iterations: 600000,
  publicKey: "_K0-Bfagmf_Jx6zhs7liJQ92RMtDjmgTQLxj6GQUfls",
};

const node = (id: string, agent = "0.3.1") =>
  ({
    id,
    name: id.slice(0, 2),
    agent_version: agent,
    enrolled_at: "2026-09-29 09:00:00",
    disabled_at: null,
  }) as NodeRecord;

const device = (id: string, core = true): DeviceRecord => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  alg: -7,
  publicKey: `${id}-key`,
  createdAt: "2026-09-29T09:00:00.000Z",
  lastUsedAt: null,
  verifies: true,
  fingerprint: `${id}-print`.padEnd(16, "0").slice(0, 16),
  core,
});

const trust = (
  version: number,
  core: DeviceRecord[],
  access: DeviceRecord[],
  passphrase = false,
): NodeTrust => ({
  version,
  core: core.map((entry) => entry.fingerprint),
  access: access.map((entry) => entry.fingerprint),
  passphrase,
});

const laptop = device("laptop");
const phone = device("phone");
const tablet = device("tablet", false);

function view(
  devices: DeviceRecord[],
  servers: { node: NodeRecord; trust: NodeTrust | null }[],
  passphrase: PassphraseKey | null = null,
): FleetView {
  return { devices, servers, passphrase, origin: ORIGIN };
}

const bytes = (text: string) =>
  JSON.parse(atob(text.replaceAll("-", "+").replaceAll("_", "/"))) as Record<
    string,
    unknown
  >;

describe("fingerprints", () => {
  it("fingerprints a key the way the agent does", async () => {
    expect(await fingerprint("AQID")).toBe("039058c6f2c0cb49");
  });

  it("groups a fingerprint for reading aloud", () => {
    expect(formatPrint("a1b2c3d4e5f6a7b8")).toBe("A1B2 C3D4 E5F6 A7B8");
  });
});

describe("access", () => {
  it("maps a server's access to device ids", () => {
    expect(
      accessIds([laptop, phone], trust(2, [laptop, phone], [phone])),
    ).toEqual(["phone"]);
    expect(accessIds([laptop], null)).toEqual([]);
  });

  it("opens a session only with devices every target lets in", () => {
    const tabletCore = { ...tablet, core: true };
    const devices = [laptop, phone, tabletCore];
    expect(
      signersFor(devices, [
        trust(2, devices, [laptop, phone]),
        trust(2, devices, [phone, tabletCore]),
      ]),
    ).toEqual(["phone"]);
    expect(signersFor(devices, [null])).toEqual([]);
    expect(signersFor(devices, [])).toEqual([]);
  });

  it("offers a server restart to a current agent with access", () => {
    const own = trust(1, [laptop], [laptop]);
    expect(canRestartServer(node(N1, "0.3.1"), own)).toBe(true);
    expect(canRestartServer(node(N1, "0.3.0"), own)).toBe(false);
    expect(canRestartServer(node(N1), trust(1, [laptop], []))).toBe(false);
    expect(canRestartServer(node(N1), null)).toBe(false);
  });
});

describe("server state", () => {
  it("sorts servers into update, empty, behind and current", () => {
    const fleet = view(
      [laptop, phone],
      [
        { node: node(N1, "0.2.3"), trust: trust(1, [laptop], [laptop]) },
        { node: node(N2), trust: null },
        { node: node(N3), trust: trust(2, [laptop], [laptop]) },
      ],
    );
    expect(fleet.servers.map((entry) => serverState(fleet, entry))).toEqual([
      "update",
      "empty",
      "behind",
    ]);
    const current = view(
      [laptop, phone],
      [{ node: node(N1), trust: trust(3, [laptop, phone], []) }],
    );
    expect(serverState(current, current.servers[0]!)).toBe("current");
    const strict = view(
      [laptop, phone],
      [{ node: node(N1), trust: trust(3, [laptop, phone], []) }],
      PASS,
    );
    expect(serverState(strict, strict.servers[0]!)).toBe("behind");
  });

  it("the next version beats every server", () => {
    expect(
      nextVersion(
        view(
          [laptop],
          [
            { node: node(N1), trust: trust(2, [laptop], []) },
            { node: node(N2), trust: trust(5, [laptop], []) },
            { node: node(N3), trust: null },
          ],
        ),
      ),
    ).toBe(6);
    expect(nextVersion(view([laptop], []))).toBe(2);
  });
});

describe("changes", () => {
  const two = view(
    [laptop, phone, tablet],
    [
      { node: node(N1), trust: trust(4, [laptop, phone], [laptop, phone]) },
      { node: node(N2), trust: trust(4, [laptop, phone], [laptop]) },
      { node: node(N3), trust: null },
    ],
  );

  it("encodes a change as the exact bytes the servers read", () => {
    const text = buildChange(two, {
      core: null,
      passphrase: null,
      access: { [N1]: ["laptop"] },
      now: T,
    });
    expect(bytes(text)).toEqual({
      v: 2,
      origin: ORIGIN,
      rpId: "kry.example.test",
      version: 5,
      issuedAt: new Date(T).toISOString(),
      expiresAt: new Date(T + 24 * 3_600_000).toISOString(),
      core: null,
      passphrase: null,
      access: { [N1]: ["laptop"] },
    });
    expect(decodeChange(text)).toEqual(bytes(text));
    expect(decodeChange("bm90IGpzb24")).toBeNull();
    expect(decodeChange(btoa(JSON.stringify({ v: 1 })))).toBeNull();
  });

  it("admits a third device into the core without access", () => {
    const change = admitChange(two, tablet);
    expect(change.core?.map((key) => key.id)).toEqual([
      "laptop",
      "phone",
      "tablet",
    ]);
    expect(change.core?.[2]).toEqual({
      id: "tablet",
      name: "Tablet",
      alg: -7,
      publicKey: "tablet-key",
    });
    expect(change.access).toEqual({
      [N1]: ["laptop", "phone"],
      [N2]: ["laptop"],
    });
  });

  it("admits the second device with access to every trusted server (founding)", () => {
    const one = view(
      [laptop, { ...phone, core: false }],
      [
        { node: node(N1), trust: trust(1, [laptop], [laptop]) },
        { node: node(N2), trust: trust(1, [laptop], [laptop]) },
      ],
    );
    expect(admitChange(one, phone).access).toEqual({
      [N1]: ["laptop", "phone"],
      [N2]: ["laptop", "phone"],
    });
  });

  it("removes a core device and its access everywhere", () => {
    const change = removeChange(two, phone);
    expect(change.core?.map((key) => key.id)).toEqual(["laptop"]);
    expect(change.access).toEqual({ [N1]: ["laptop"], [N2]: ["laptop"] });
  });

  it("changes access only on the servers that differ", () => {
    expect(
      accessChange(two, {
        [N1]: ["phone", "laptop"],
        [N2]: ["laptop", "phone"],
      }),
    ).toEqual({
      core: null,
      passphrase: null,
      access: { [N2]: ["laptop", "phone"] },
    });
    expect(accessChange(two, { [N1]: ["laptop", "phone"] }).access).toEqual({});
  });

  it("syncs servers that missed a change, adding the passphrase only where missing", () => {
    const behind = view(
      [laptop, phone],
      [
        { node: node(N1), trust: trust(4, [laptop, phone], [laptop], true) },
        { node: node(N2), trust: trust(3, [laptop], [laptop], false) },
      ],
      PASS,
    );
    const change = syncChange(behind);
    expect(change.core?.map((key) => key.id)).toEqual(["laptop", "phone"]);
    expect(change.passphrase).toEqual(PASS);
    expect(change.access).toEqual({ [N1]: ["laptop"], [N2]: ["laptop"] });
    const clean = view(
      [laptop, phone],
      [{ node: node(N1), trust: trust(4, [laptop, phone], [laptop], true) }],
      PASS,
    );
    expect(syncChange(clean).passphrase).toBeNull();
  });

  it("first trust sends the core with founding access, one server each", () => {
    const fresh = view(
      [{ ...laptop, core: false }],
      [
        { node: node(N1), trust: null },
        { node: node(N2), trust: null },
      ],
    );
    const [first, second] = firstTrusts(fresh, [N1, N2], "laptop", T).map(
      bytes,
    );
    expect(first).toMatchObject({
      version: 1,
      core: [{ id: "laptop" }],
      passphrase: null,
      access: { [N1]: ["laptop"] },
    });
    expect(second?.access).toEqual({ [N2]: ["laptop"] });
    const later = view(
      [laptop, phone],
      [
        { node: node(N1), trust: trust(4, [laptop, phone], [laptop]) },
        { node: node(N3), trust: null },
      ],
      PASS,
    );
    expect(bytes(firstTrusts(later, [N3], "laptop", T)[0]!)).toMatchObject({
      version: 1,
      core: [{ id: "laptop" }, { id: "phone" }],
      passphrase: PASS,
      access: { [N3]: [] },
    });
  });

  it("describes a change from its bytes with names and per-server access", () => {
    const text = buildChange(two, { ...admitChange(two, tablet), now: T });
    const summary = describeChange(two, decodeChange(text)!);
    expect(summary.title).toBe("Admit Tablet");
    const grant = buildChange(two, {
      core: null,
      passphrase: null,
      access: { [N2]: ["laptop", "phone"] },
      now: T,
    });
    expect(describeChange(two, decodeChange(grant)!)).toMatchObject({
      title: "Change access on 1 server",
      access: [{ nodeId: N2, added: ["phone"], removed: [] }],
    });
    const pass = buildChange(two, {
      core: null,
      passphrase: PASS,
      access: { [N1]: ["laptop", "phone"], [N2]: ["laptop"] },
      now: T,
    });
    expect(describeChange(two, decodeChange(pass)!).title).toBe(
      "Set passphrase",
    );
  });
});

describe("prediction", () => {
  const fleet = view(
    [laptop, phone, tablet],
    [
      { node: node(N1), trust: trust(4, [laptop, phone], [laptop]) },
      { node: node(N2), trust: trust(4, [laptop, phone], []) },
    ],
  );

  it("says what the approvers still miss, the way servers count", () => {
    const admit = decodeChange(
      buildChange(fleet, { ...admitChange(fleet, tablet), now: T }),
    )!;
    expect(predictMissing(fleet, admit, ["laptop"])).toBe(
      "needs 1 more core device",
    );
    expect(predictMissing(fleet, admit, ["laptop", "phone"])).toBeNull();
    const grant = decodeChange(
      buildChange(fleet, {
        ...accessChange(fleet, { [N1]: ["laptop", "phone"], [N2]: ["phone"] }),
        now: T,
      }),
    )!;
    expect(predictMissing(fleet, grant, ["phone"])).toBe(
      "needs approval from another device with access here",
    );
    expect(predictMissing(fleet, grant, ["laptop"])).toBeNull();
  });
});

describe("fingerprint rule", () => {
  const touch = { ...laptop, verifies: false };
  const ruled = (
    core: DeviceRecord[],
    access: DeviceRecord[],
    version = 4,
  ): NodeTrust => ({ ...trust(version, core, access), requireUv: true });
  const before = view(
    [touch, phone],
    [
      {
        node: node(N1, "0.3.1"),
        trust: trust(4, [touch, phone], [touch, phone], true),
      },
      { node: node(N2, "0.3.1"), trust: trust(4, [touch, phone], [touch]) },
      { node: node(N3, "0.3.1"), trust: null },
    ],
    PASS,
  );

  it("turns the rule on by removing devices that only touch, everywhere", () => {
    const plan = requireUvChange(before);
    expect(plan.core?.map((key) => key.id)).toEqual(["phone"]);
    expect(plan.passphrase).toBeNull();
    expect(plan.requireUv).toBe(true);
    expect(plan.access).toEqual({ [N1]: ["phone"], [N2]: [] });
    expect(bytes(buildChange(before, { ...plan, now: T }))).toMatchObject({
      requireUv: true,
      passphrase: null,
    });
    expect(
      describeChange(before, decodeChange(buildChange(before, plan))!).title,
    ).toBe("Remove Laptop · Require fingerprint");
  });

  it("predicts the approvals the rule needs", () => {
    const change = decodeChange(
      buildChange(before, { ...requireUvChange(before), now: T }),
    )!;
    expect(predictMissing(before, change, ["laptop"])).toBe(
      "needs 1 more core device",
    );
    expect(predictMissing(before, change, ["laptop", "phone"])).toBeNull();
    const keeping = decodeChange(
      buildChange(before, {
        core: null,
        passphrase: null,
        requireUv: true,
        access: { [N1]: ["laptop", "phone"], [N2]: ["laptop"] },
        now: T,
      }),
    )!;
    expect(predictMissing(before, keeping, ["laptop", "phone"])).toBe(
      "every core device that stays must approve with a fingerprint",
    );
  });

  it("says why the rule cannot be turned on yet", () => {
    expect(uvBlocker(before)).toBeNull();
    const old = view(
      [touch, phone],
      [{ node: node(N1, "0.3.0"), trust: trust(4, [touch, phone], [touch]) }],
    );
    expect(uvBlocker(old)).toBe("Update 11 to agent 0.3.1 first.");
    const onlyTouch = view(
      [touch],
      [{ node: node(N1, "0.3.1"), trust: trust(4, [touch], [touch]) }],
    );
    expect(uvBlocker(onlyTouch)).toMatch(/^Add a device that verifies/u);
  });

  it("keeps the rule on new and lagging servers", () => {
    const after = view(
      [phone, tablet],
      [
        { node: node(N1, "0.3.1"), trust: ruled([phone], [phone], 5) },
        { node: node(N2, "0.3.1"), trust: trust(4, [phone], [phone]) },
        { node: node(N3, "0.3.1"), trust: null },
      ],
    );
    expect(fingerprintsRequired(after)).toBe(true);
    expect(fingerprintsRequired(before)).toBe(false);
    expect(serverState(after, after.servers[1]!)).toBe("behind");
    const sync = syncChange(after);
    expect(sync.requireUv).toBe(true);
    expect(sync.passphrase).toBeNull();
    const [first] = firstTrusts(after, [N3], "phone", T);
    expect(bytes(first!)).toMatchObject({ requireUv: true, passphrase: null });
  });
});
