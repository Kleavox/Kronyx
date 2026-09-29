import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { RowMenu } from "@/components/row-menu";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ActionOutcome, PendingText } from "@/features/services/service-list";
import { useCancelActions } from "@/lib/api";
import { nodeState, timeAgo } from "@/lib/format";
import { isPending } from "@/lib/services";
import {
  containersOf,
  deployBlocker,
  type StackGroup,
  type StackMember,
} from "@/lib/stacks";
import { cn } from "@/lib/utils";
import type { ServiceEntry } from "@/types";

import type { DeployRequest } from "./deploy-dialog";

const ROW =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)_10rem]";

const offline = (member: StackMember, seen: number) =>
  nodeState(member.node, seen) === "offline";

const tone = (member: StackMember) =>
  member.stack.running === member.stack.total
    ? "ok"
    : member.stack.running === 0
      ? "bad"
      : "warn";

function stackLabel(member: StackMember, seen: number, server: boolean) {
  const count = `${member.stack.running}/${member.stack.total} running`;
  const state = offline(member, seen)
    ? `${count}, last known ${timeAgo(member.node.last_seen_at, seen)}`
    : count;
  return server ? `${state} · ${member.node.name}` : state;
}

function LastDeploy({ member }: { member: StackMember }) {
  const action = member.action;
  if (!action) return <span>no deploy yet</span>;
  return isPending(action) ? (
    <PendingText action={action} nodeName={member.node.name} />
  ) : (
    <ActionOutcome action={action} nodeName={member.node.name} />
  );
}

function MemberControls({
  project,
  member,
  containersOpen,
  onToggleContainers,
  onRequest,
}: {
  project: string;
  member: StackMember;
  containersOpen: boolean;
  onToggleContainers: () => void;
  onRequest: (request: DeployRequest) => void;
}) {
  const cancel = useCancelActions();
  const blocker = deployBlocker(member);
  const action = member.action;
  if (action && isPending(action)) {
    return action.status === "queued" ? (
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-11 md:h-8"
          onClick={() => cancel.mutate(action.batchId)}
        >
          Cancel
        </Button>
      </div>
    ) : null;
  }
  if (blocker) {
    return (
      <p className="text-right text-xs text-muted-foreground">
        {blocker === "Not trusted yet" ? (
          <Link
            to="/devices"
            className="underline underline-offset-4 hover:text-foreground"
          >
            {blocker}
          </Link>
        ) : (
          blocker
        )}
      </p>
    );
  }
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-11 md:h-8"
        aria-label={`Deploy ${project} on ${member.node.name}`}
        onClick={() =>
          onRequest({ action: "deploy", project, members: [member] })
        }
      >
        Deploy
      </Button>
      <RowMenu
        label={`${project} on ${member.node.name} actions`}
        items={[
          ...(member.stack.rollback
            ? [
                {
                  label: "Roll back",
                  onSelect: () =>
                    onRequest({
                      action: "rollback",
                      project,
                      members: [member],
                    }),
                },
              ]
            : []),
          {
            label: containersOpen ? "Hide containers" : "Show containers",
            onSelect: onToggleContainers,
          },
        ]}
      />
    </div>
  );
}

function Containers({ entries }: { entries: ServiceEntry[] }) {
  return (
    <ul className="space-y-0.5 border-t bg-background/40 px-3 py-2 pl-6 font-mono text-xs text-muted-foreground md:pl-14">
      {entries.length === 0 ? (
        <li>No containers named after this stack.</li>
      ) : (
        entries.map((entry) => (
          <li key={entry.name} className="flex gap-2">
            <span className="truncate text-foreground">{entry.name}</span>
            <span>{entry.state}</span>
          </li>
        ))
      )}
    </ul>
  );
}

export function StackList({
  groups,
  seen,
  showServer,
  services,
  onRequest,
}: {
  groups: StackGroup[];
  seen: number;
  showServer: boolean;
  services: Map<string, ServiceEntry[]>;
  onRequest: (request: DeployRequest) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const containers = (member: StackMember, project: string) =>
    open.has(`containers|${member.node.id}|${project}`) && (
      <Containers
        entries={containersOf(project, services.get(member.node.id) ?? [])}
      />
    );
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {groups.map((group) => {
        const [single] = group.members.length === 1 ? group.members : [];
        const expanded = open.has(group.project);
        const listId = `stack-${group.project}`;
        const deployable = group.members.filter(
          (member) => deployBlocker(member) === null,
        );
        const healthy = group.members.filter(
          (member) => member.stack.running === member.stack.total,
        ).length;
        return (
          <li key={group.project}>
            <div
              className={cn(
                ROW,
                "px-3 py-2.5",
                single && offline(single, seen) && "opacity-60",
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                {single ? (
                  <StatusDot tone={tone(single)} />
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 md:size-8"
                    aria-expanded={expanded}
                    aria-controls={listId}
                    aria-label={`${expanded ? "Hide" : "Show"} servers for ${group.project}`}
                    onClick={() => toggle(group.project)}
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        "transition-transform",
                        expanded && "rotate-90",
                      )}
                    />
                  </Button>
                )}
                <span className="truncate font-medium">{group.project}</span>
              </div>
              <span className="col-span-2 font-mono text-xs text-muted-foreground md:col-span-1">
                {single
                  ? stackLabel(single, seen, showServer)
                  : `compose · ${healthy}/${group.members.length} fully running`}
              </span>
              <span
                className="col-span-2 min-w-0 font-mono text-xs text-muted-foreground md:col-span-1"
                aria-live="polite"
              >
                {single ? (
                  <LastDeploy member={single} />
                ) : (
                  `${group.members.length} servers`
                )}
              </span>
              <div className="col-start-2 row-start-1 md:col-start-auto md:row-start-auto">
                {single ? (
                  <MemberControls
                    project={group.project}
                    member={single}
                    containersOpen={open.has(
                      `containers|${single.node.id}|${group.project}`,
                    )}
                    onToggleContainers={() =>
                      toggle(`containers|${single.node.id}|${group.project}`)
                    }
                    onRequest={onRequest}
                  />
                ) : (
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11 md:h-8"
                      disabled={deployable.length === 0}
                      aria-label={`Deploy ${group.project} on ${deployable.length} ${deployable.length === 1 ? "server" : "servers"}`}
                      onClick={() =>
                        onRequest({
                          action: "deploy",
                          project: group.project,
                          members: group.members,
                        })
                      }
                    >
                      Deploy
                    </Button>
                  </div>
                )}
              </div>
            </div>
            {single && containers(single, group.project)}
            {!single && expanded && (
              <ul id={listId} className="divide-y border-t">
                {group.members.map((member) => (
                  <li key={member.node.id}>
                    <div
                      className={cn(
                        ROW,
                        "px-3 py-2",
                        offline(member, seen) && "opacity-60",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2 pl-3 md:pl-10">
                        <StatusDot tone={tone(member)} />
                        <span className="truncate">{member.node.name}</span>
                      </span>
                      <span className="col-span-2 pl-3 font-mono text-xs text-muted-foreground md:col-span-1 md:pl-0">
                        {stackLabel(member, seen, false)}
                      </span>
                      <span
                        className="col-span-2 min-w-0 pl-3 font-mono text-xs text-muted-foreground md:col-span-1 md:pl-0"
                        aria-live="polite"
                      >
                        <LastDeploy member={member} />
                      </span>
                      <div className="col-start-2 row-start-1 md:col-start-auto md:row-start-auto">
                        <MemberControls
                          project={group.project}
                          member={member}
                          containersOpen={open.has(
                            `containers|${member.node.id}|${group.project}`,
                          )}
                          onToggleContainers={() =>
                            toggle(
                              `containers|${member.node.id}|${group.project}`,
                            )
                          }
                          onRequest={onRequest}
                        />
                      </div>
                    </div>
                    {containers(member, group.project)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
