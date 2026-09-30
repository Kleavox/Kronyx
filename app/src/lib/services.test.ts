import { describe, expect, it } from "vitest";

import type { ActionRecord, NodeRecord, ServicesResponse } from "../types";
import {
  actionText,
  displayName,
  durationText,
  groupByServer,
  isPending,
  newlyFinished,
  outcomeText,
  pollServices,
  primaryAction,
  refreshPending,
  serviceForCheck,
  verb,
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

describe("grouping services by server", () => {
  const names = (groups: ReturnType<typeof groupByServer>) =>
    groups.map((group) => [
      group.node.name,
      group.members.map((member) => member.entry.name),
    ]);
  const all = { showSystem: false, query: "", notRunning: false };

  it("lists each server's services, troubled servers first, without system units", () => {
    const groups = groupByServer(data, nodes, all);
    expect(names(groups)).toEqual([
      ["vps-sg", ["adguard"]],
      ["PIVOX", ["adguard", "nginx.service"]],
      ["zeta", ["adguard"]],
    ]);
    expect(groups[1]!.members[0]!.action?.id).toBe("new-action");
  });

  it("puts a server's stopped services first", () => {
    const stopped: ServicesResponse = {
      ...data,
      nodes: [
        {
          ...data.nodes[0]!,
          services: data.nodes[0]!.services.map((entry) =>
            entry.name === "nginx.service"
              ? { ...entry, state: "failed" as const }
              : entry,
          ),
        },
      ],
    };
    expect(names(groupByServer(stopped, nodes, all))).toEqual([
      ["PIVOX", ["nginx.service", "adguard"]],
    ]);
  });

  it("shows system units, searches services or servers and filters on request", () => {
    expect(
      names(groupByServer(data, nodes, { ...all, showSystem: true }))[1],
    ).toEqual(["PIVOX", ["adguard", "cron.service", "nginx.service"]]);
    expect(
      names(groupByServer(data, nodes, { ...all, query: "NGINX" })),
    ).toEqual([["PIVOX", ["nginx.service"]]]);
    expect(
      names(groupByServer(data, nodes, { ...all, query: "zeta" })),
    ).toEqual([["zeta", ["adguard"]]]);
    expect(
      names(groupByServer(data, nodes, { ...all, notRunning: true })),
    ).toEqual([["vps-sg", ["adguard"]]]);
  });

  it("knows which servers trust a device", () => {
    const trusted: ServicesResponse = {
      ...data,
      nodes: data.nodes.map((entry) =>
        entry.id === "n3"
          ? { ...entry, trust: { version: 1, keys: ["0123456789abcdef"] } }
          : entry,
      ),
    };
    expect(
      groupByServer(trusted, nodes, all).map((group) => group.trusted),
    ).toEqual([false, false, true]);
  });

  it("offers the likely action first", () => {
    expect(primaryAction("running")).toBe("restart");
    expect(primaryAction("starting")).toBe("restart");
    expect(primaryAction("stopped")).toBe("start");
    expect(primaryAction("failed")).toBe("start");
  });
});

describe("action labels", () => {
  it("describes every stage", () => {
    expect(actionText(action({}), "PIVOX")).toBe("Waiting for PIVOX");
    expect(actionText(action({ deliverableAt: null }), "PIVOX")).toBe(
      "Waiting for its turn",
    );
    expect(actionText(action({ status: "sent" }), "PIVOX")).toBe("Restarting…");
    expect(
      actionText(
        action({ status: "done", finishedAt: "2026-09-29T10:01:05.000Z" }),
        "PIVOX",
      ),
    ).toMatch(/^✓ Restarted \d\d:\d\d$/u);
    expect(actionText(action({ status: "failed", exitCode: 1 }), "PIVOX")).toBe(
      "Failed · exit 1",
    );
    expect(actionText(action({ status: "failed" }), "PIVOX")).toBe("Failed");
    expect(actionText(action({ status: "expired" }), "PIVOX")).toBe("Expired");
    expect(actionText(action({ status: "skipped" }), "PIVOX")).toBe("Skipped");
    expect(
      actionText(action({ action: "stop", status: "sent" }), "PIVOX"),
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
  it("names a server restart", () => {
    const reboot = action({ kind: "host", name: "server", action: "reboot" });
    expect(`${verb("reboot")} ${displayName("host", "server")}`).toBe(
      "Restart server",
    );
    expect(actionText({ ...reboot, status: "sent" }, "PIVOX")).toBe(
      "Restarting…",
    );
    expect(outcomeText({ ...reboot, status: "done" }, "PIVOX")).toEqual({
      ok: true,
      text: "PIVOX restarted",
    });
  });
});
