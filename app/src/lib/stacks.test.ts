import { describe, expect, it } from "vitest";

import type { NodeRecord, ServicesResponse, StackEntry } from "../types";
import { actionText, outcomeText } from "./services";
import { containersOf, deployBlocker, groupStacks } from "./stacks";

const node = (id: string, name: string, agent = "0.3.1") =>
  ({
    id,
    name,
    agent_version: agent,
    enrolled_at: "2026-09-29 09:00:00",
    disabled_at: null,
    last_seen_at: "2026-09-29 09:59:30",
    interval_seconds: 60,
  }) as NodeRecord;

const stack = (
  project: string,
  overrides: Partial<StackEntry> = {},
): StackEntry => ({
  project,
  directory: `/opt/${project}`,
  running: 2,
  total: 2,
  compose: true,
  rollback: false,
  ...overrides,
});

const trusted = {
  version: 1,
  core: ["0123456789abcdef"],
  access: ["0123456789abcdef"],
  passphrase: false,
};

const data: ServicesResponse = {
  nodes: [
    {
      id: "n1",
      inventoryAt: null,
      refreshRequestedAt: null,
      services: [
        {
          kind: "docker",
          name: "listmonk_app",
          state: "running",
          since: null,
          system: false,
        },
        {
          kind: "docker",
          name: "listmonk-db-1",
          state: "running",
          since: null,
          system: false,
        },
        {
          kind: "docker",
          name: "adguard",
          state: "running",
          since: null,
          system: false,
        },
      ],
      stacks: [
        stack("listmonk", { rollback: true }),
        stack("shop", { running: 1 }),
      ],
      trust: trusted,
    },
    {
      id: "n2",
      inventoryAt: null,
      refreshRequestedAt: null,
      services: [],
      stacks: [stack("listmonk")],
      trust: null,
    },
  ],
  actions: [],
};

const nodes = [node("n1", "Callisto"), node("n2", "Pivox")];

describe("stacks", () => {
  it("groups one project across servers and puts unhealthy stacks first", () => {
    const groups = groupStacks(data, nodes, "");
    expect(groups.map((group) => group.project)).toEqual(["shop", "listmonk"]);
    expect(groups[1]!.members.map((member) => member.node.name)).toEqual([
      "Callisto",
      "Pivox",
    ]);
    expect(
      groupStacks(data, nodes, "PIVOX").map((group) => group.project),
    ).toEqual(["listmonk"]);
  });

  it("keeps reading logs out of a stack's last action", () => {
    const entry = (id: string, action: "deploy" | "logs") => ({
      id,
      batchId: id,
      position: 0,
      mode: "rolling" as const,
      nodeId: "n1",
      kind: "compose" as const,
      name: "listmonk",
      action,
      status: "done" as const,
      requestedBy: "owner@example.test",
      requestedAt: "2026-09-29T09:00:00.000Z",
      deliverableAt: "2026-09-29T09:00:00.000Z",
      deviceId: null,
      sentAt: null,
      finishedAt: null,
      exitCode: null,
      output: null,
    });
    const groups = groupStacks(
      { ...data, actions: [entry("a1", "deploy"), entry("a2", "logs")] },
      nodes,
      "",
    );
    const listmonk = groups.find((group) => group.project === "listmonk")!;
    expect(listmonk.members[0]!.action?.id).toBe("a1");
  });

  it("offers rollback only when a version is kept", () => {
    const [, listmonk] = groupStacks(data, nodes, "");
    expect(listmonk!.members.map((member) => member.stack.rollback)).toEqual([
      true,
      false,
    ]);
  });

  it("names why a stack cannot deploy yet", () => {
    const [, listmonk] = groupStacks(data, nodes, "");
    expect(deployBlocker(listmonk!.members[0]!)).toBeNull();
    expect(deployBlocker(listmonk!.members[1]!)).toBe("Not trusted yet");
    expect(
      deployBlocker({
        ...listmonk!.members[0]!,
        node: node("n1", "Callisto", "0.3.0"),
      }),
    ).toBe("Needs agent 0.3.1");
    expect(
      deployBlocker({
        ...listmonk!.members[0]!,
        stack: stack("listmonk", { compose: false }),
      }),
    ).toBe("Docker Compose is not installed");
  });

  it("lists a stack's containers", () => {
    expect(
      containersOf("listmonk", data.nodes[0]!.services).map(
        (entry) => entry.name,
      ),
    ).toEqual(["listmonk-db-1", "listmonk_app"]);
  });

  it("words deploys and rollbacks", () => {
    const deploy = {
      id: "a1",
      batchId: "b1",
      position: 0,
      mode: "rolling" as const,
      nodeId: "n1",
      kind: "compose" as const,
      name: "listmonk",
      action: "deploy" as const,
      status: "sent" as const,
      requestedBy: "owner@example.test",
      requestedAt: "2026-09-29T10:00:00.000Z",
      deliverableAt: "2026-09-29T10:00:00.000Z",
      sentAt: "2026-09-29T10:00:30.000Z",
      finishedAt: null,
      exitCode: null,
      output: null,
      deviceId: null,
    };
    expect(actionText(deploy, "Callisto")).toBe("Deploying…");
    expect(
      outcomeText(
        { ...deploy, status: "done", finishedAt: "2026-09-29T10:03:00.000Z" },
        "Callisto",
      ),
    ).toEqual({ ok: true, text: "listmonk deployed on Callisto" });
    expect(
      outcomeText(
        {
          ...deploy,
          action: "rollback",
          status: "done",
          finishedAt: "2026-09-29T10:03:00.000Z",
        },
        "Callisto",
      ),
    ).toEqual({ ok: true, text: "listmonk rolled back on Callisto" });
  });
});
