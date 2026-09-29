import { describe, expect, it } from "vitest";

import type { ActionRecord, NodeRecord, ServicesResponse } from "../types";
import {
  actionStage,
  actionText,
  batchText,
  bulkTargets,
  durationText,
  groupPrimary,
  groupServices,
  isPending,
  newlyFinished,
  nextReportIn,
  outcomeText,
  pollServices,
  primaryAction,
  refreshPending,
  serviceForCheck,
} from "./services";

const node = (id: string, name: string, agent = "0.1.0") =>
  ({ id, name, agent_version: agent }) as NodeRecord;

const action = (overrides: Partial<ActionRecord>): ActionRecord => ({
  id: "a1",
  batchId: "b1",
  position: 0,
  mode: "rolling",
  nodeId: "n1",
  kind: "docker",
  name: "adguard",
  action: "restart",
  status: "queued",
  requestedAt: "2026-09-29T10:00:00.000Z",
  deliverableAt: "2026-09-29T10:00:00.000Z",
  sentAt: null,
  finishedAt: null,
  exitCode: null,
  output: null,
  ...overrides,
});

const data: ServicesResponse = {
  nodes: [
    {
      id: "n1",
      inventoryAt: null,
      refreshRequestedAt: null,
      stacks: [],
      trust: null,
      services: [
        {
          kind: "docker",
          name: "adguard",
          state: "running",
          since: null,
          system: false,
        },
        {
          kind: "systemd",
          name: "nginx.service",
          state: "running",
          since: null,
          system: false,
        },
        {
          kind: "systemd",
          name: "cron.service",
          state: "running",
          since: null,
          system: true,
        },
      ],
    },
    {
      id: "n2",
      inventoryAt: null,
      refreshRequestedAt: null,
      stacks: [],
      trust: null,
      services: [
        {
          kind: "docker",
          name: "adguard",
          state: "stopped",
          since: null,
          system: false,
        },
      ],
    },
    {
      id: "n3",
      inventoryAt: null,
      refreshRequestedAt: null,
      stacks: [],
      trust: null,
      services: [
        {
          kind: "docker",
          name: "adguard",
          state: "running",
          since: null,
          system: false,
        },
      ],
    },
  ],
  actions: [
    action({
      id: "old-action",
      nodeId: "n1",
      status: "done",
      requestedAt: "2026-09-29T09:00:00.000Z",
    }),
    action({
      id: "new-action",
      nodeId: "n1",
      status: "sent",
      requestedAt: "2026-09-29T10:00:00.000Z",
    }),
  ],
};

const nodes = [node("n1", "PIVOX"), node("n2", "vps-sg"), node("n3", "zeta")];

describe("grouping services", () => {
  it("merges a service across servers and leaves out system units", () => {
    const groups = groupServices(data, nodes, {
      showSystem: false,
      query: "",
      notRunning: false,
    });
    expect(groups.map((group) => group.key)).toEqual([
      "docker:adguard",
      "systemd:nginx.service",
    ]);
    expect(groups[0]!.members.map((member) => member.node.name)).toEqual([
      "PIVOX",
      "vps-sg",
      "zeta",
    ]);
    expect(groups[0]!.members[0]!.action?.id).toBe("new-action");
  });

  it("shows system units, searches and filters on request", () => {
    expect(
      groupServices(data, nodes, {
        showSystem: true,
        query: "",
        notRunning: false,
      }).map((group) => group.name),
    ).toContain("cron.service");
    expect(
      groupServices(data, nodes, {
        showSystem: false,
        query: "NGINX",
        notRunning: false,
      }).map((group) => group.name),
    ).toEqual(["nginx.service"]);
    expect(
      groupServices(data, nodes, {
        showSystem: false,
        query: "",
        notRunning: true,
      }).map((group) => group.name),
    ).toEqual(["adguard"]);
  });

  it("puts services that are not fully running first", () => {
    const groups = groupServices(data, nodes, {
      showSystem: false,
      query: "",
      notRunning: false,
    });
    expect(groups[0]!.name).toBe("adguard");
  });

  it("offers the likely action first", () => {
    expect(primaryAction("running")).toBe("restart");
    expect(primaryAction("starting")).toBe("restart");
    expect(primaryAction("stopped")).toBe("start");
    expect(primaryAction("failed")).toBe("start");
    const [adguard] = groupServices(data, nodes, {
      showSystem: false,
      query: "",
      notRunning: false,
    });
    expect(groupPrimary(adguard!)).toBe("restart");
  });
});

describe("action labels", () => {
  it("counts down to the next report at second 2", () => {
    expect(nextReportIn(Date.parse("2026-09-29T10:00:02.000Z"))).toBe(60);
    expect(nextReportIn(Date.parse("2026-09-29T10:00:01.000Z"))).toBe(1);
    expect(nextReportIn(Date.parse("2026-09-29T10:00:27.400Z"))).toBe(35);
  });

  it("describes every stage", () => {
    const now = Date.parse("2026-09-29T10:00:27.000Z");
    expect(actionText(action({}), "PIVOX", now)).toBe(
      "Waiting for PIVOX · ~35s",
    );
    expect(actionText(action({ deliverableAt: null }), "PIVOX", now)).toBe(
      "Waiting for its turn",
    );
    expect(actionText(action({ status: "sent" }), "PIVOX", now)).toBe(
      "Restarting…",
    );
    expect(
      actionText(
        action({ status: "done", finishedAt: "2026-09-29T10:01:05.000Z" }),
        "PIVOX",
        now,
      ),
    ).toMatch(/^✓ Restarted \d\d:\d\d$/u);
    expect(
      actionText(action({ status: "failed", exitCode: 1 }), "PIVOX", now),
    ).toBe("Failed · exit 1");
    expect(actionText(action({ status: "failed" }), "PIVOX", now)).toBe(
      "Failed",
    );
    expect(actionText(action({ status: "expired" }), "PIVOX", now)).toBe(
      "Expired",
    );
    expect(actionText(action({ status: "skipped" }), "PIVOX", now)).toBe(
      "Skipped",
    );
    expect(
      actionText(action({ action: "stop", status: "sent" }), "PIVOX", now),
    ).toBe("Stopping…");
  });

  it("measures how long a finished action took", () => {
    expect(
      durationText(
        action({
          sentAt: "2026-09-29T10:01:02.000Z",
          finishedAt: "2026-09-29T10:01:05.200Z",
        }),
      ),
    ).toBe("3s");
    expect(durationText(action({}))).toBeNull();
  });

  it("follows a rolling batch and says where it stopped", () => {
    const names = (id: string) =>
      ({ n1: "PIVOX", n2: "vps-sg", n3: "vps-de" })[id] ?? id;
    const batch = [
      action({ id: "1", nodeId: "n1", position: 0, status: "done" }),
      action({ id: "2", nodeId: "n2", position: 1, status: "sent" }),
      action({
        id: "3",
        nodeId: "n3",
        position: 2,
        status: "queued",
        deliverableAt: null,
      }),
    ];
    expect(batchText(batch, names)).toBe("Restarting 2/3 · vps-sg");
    expect(
      batchText(
        [
          batch[0]!,
          { ...batch[1]!, status: "failed" },
          { ...batch[2]!, status: "skipped" },
        ],
        names,
      ),
    ).toBe("Stopped at vps-sg");
    expect(
      batchText(
        batch.map((entry) => ({ ...entry, mode: "parallel" as const })),
        names,
      ),
    ).toBe("Restarting 3 servers");
    expect(batchText([batch[0]!], names)).toBeNull();
    expect(
      batchText(
        batch.map((entry) => ({ ...entry, status: "done" as const })),
        names,
      ),
    ).toBeNull();
  });
});

describe("polling, checks and outcomes", () => {
  it("polls every 5 seconds while something is in flight", () => {
    const now = Date.parse("2026-09-29T10:00:30.000Z");
    expect(pollServices(data, now)).toBe(5_000);
    const quiet = { ...data, actions: [action({ status: "done" })] };
    expect(pollServices(quiet, now)).toBeGreaterThan(5_000);
    const refreshing = (at: string) => ({
      ...quiet,
      nodes: [{ ...data.nodes[0]!, refreshRequestedAt: at }],
    });
    expect(pollServices(refreshing("2026-09-29T09:59:00.000Z"), now)).toBe(
      5_000,
    );
    expect(
      pollServices(refreshing("2026-09-29T09:57:00.000Z"), now),
    ).toBeGreaterThan(5_000);
    expect(pollServices(undefined, now)).toBeGreaterThan(5_000);
  });

  it("stops waiting for a refresh after three minutes", () => {
    const now = Date.parse("2026-09-29T10:00:30.000Z");
    expect(
      refreshPending({ refreshRequestedAt: "2026-09-29T09:59:00.000Z" }, now),
    ).toBe(true);
    expect(
      refreshPending({ refreshRequestedAt: "2026-09-29T09:57:00.000Z" }, now),
    ).toBe(false);
    expect(refreshPending({ refreshRequestedAt: null }, now)).toBe(false);
  });

  it("finds the unit behind a SERVICE check", () => {
    expect(
      serviceForCheck({ kind: "SERVICE", target: "nginx", node_id: "n1" }, data)
        ?.name,
    ).toBe("nginx.service");
    expect(
      serviceForCheck(
        { kind: "SERVICE", target: "nginx.service", node_id: "n1" },
        data,
      )?.name,
    ).toBe("nginx.service");
    expect(
      serviceForCheck({ kind: "HTTP", target: "nginx", node_id: "n1" }, data),
    ).toBeNull();
    expect(
      serviceForCheck(
        { kind: "SERVICE", target: "nginx", node_id: "n2" },
        data,
      ),
    ).toBeNull();
  });

  it("reports what finished since the last look, and nothing twice", () => {
    const before = [
      action({ id: "x", status: "sent" }),
      action({ id: "y", status: "queued" }),
    ];
    const after = [
      action({ id: "x", status: "done" }),
      action({ id: "y", status: "cancelled" }),
    ];
    expect(newlyFinished(before, after).map((entry) => entry.id)).toEqual([
      "x",
      "y",
    ]);
    expect(newlyFinished(after, after)).toEqual([]);
    expect(isPending(action({ status: "sent" }))).toBe(true);
    expect(outcomeText(action({ status: "done" }), "PIVOX")).toEqual({
      ok: true,
      text: "adguard restarted on PIVOX",
    });
    expect(
      outcomeText(
        action({
          status: "failed",
          exitCode: 1,
          kind: "systemd",
          name: "nginx.service",
        }),
        "PIVOX",
      ),
    ).toEqual({
      ok: false,
      text: "Could not restart nginx on PIVOX (exit 1)",
    });
    expect(outcomeText(action({ status: "cancelled" }), "PIVOX")).toBeNull();
  });
});

describe("announcements and bulk order", () => {
  it("announces the stage without the ticking countdown", () => {
    expect(actionStage(action({}), "PIVOX")).toBe("Waiting for PIVOX");
    expect(actionStage(action({ deliverableAt: null }), "PIVOX")).toBe(
      "Waiting for its turn",
    );
    expect(actionStage(action({ status: "sent" }), "PIVOX")).toBe(
      "Restarting…",
    );
  });

  it("runs online servers first and marks the offline ones", () => {
    const seen = Date.parse("2026-09-29T10:00:00.000Z");
    const base = {
      enrolled_at: "2026-09-01 00:00:00",
      disabled_at: null,
      interval_seconds: 60,
    };
    const online = {
      ...node("n1", "b-online"),
      ...base,
      last_seen_at: "2026-09-29 09:59:30",
    } as NodeRecord;
    const offline = {
      ...node("n2", "a-offline"),
      ...base,
      last_seen_at: "2026-09-29 08:00:00",
    } as NodeRecord;
    const entry = {
      kind: "docker" as const,
      name: "adguard",
      state: "running" as const,
      since: null,
      system: false,
    };
    const group = {
      key: "docker:adguard",
      kind: "docker" as const,
      name: "adguard",
      members: [
        { node: offline, entry, action: null },
        { node: online, entry, action: null },
      ],
    };
    expect(
      bulkTargets(group, seen).map((target) => [
        target.nodeName,
        target.offline,
      ]),
    ).toEqual([
      ["b-online", false],
      ["a-offline", true],
    ]);
  });
});
