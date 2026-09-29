import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { RowMenu } from "@/components/row-menu";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { useCancelActions, useRunAction } from "@/lib/api";
import { nodeState, timeAgo } from "@/lib/format";
import {
  actionStage,
  actionText,
  batchText,
  bulkTargets,
  displayName,
  groupPrimary,
  isPending,
  primaryAction,
  running,
  toTarget,
  verb,
  type ServiceGroup,
  type ServiceMember,
} from "@/lib/services";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import type { ActionRecord, ServiceAction, ServiceState } from "@/types";

import type { ActionRequest } from "./action-dialog";

const TONE: Record<ServiceState, "ok" | "bad" | "warn" | "idle"> = {
  running: "ok",
  starting: "warn",
  stopped: "idle",
  failed: "bad",
};

const ROW =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)_10rem]";

const offline = (member: ServiceMember, seen: number) =>
  nodeState(member.node, seen) === "offline";

function stateLabel(
  member: ServiceMember,
  seen: number,
  options: { kind: boolean; server: boolean },
): string {
  const state = offline(member, seen)
    ? `${member.entry.state}, last known ${timeAgo(member.node.last_seen_at, seen)}`
    : member.entry.state;
  return [
    options.kind ? member.entry.kind : null,
    state,
    options.server ? member.node.name : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ActionOutcome({
  action,
  nodeName,
}: {
  action: ActionRecord;
  nodeName: string;
}) {
  const text = actionText(action, nodeName, 0);
  if (
    !action.output ||
    (action.status !== "failed" && action.status !== "expired")
  ) {
    return <span className="truncate">{text}</span>;
  }
  return (
    <details className="min-w-0">
      <summary className="cursor-pointer truncate text-destructive">
        {text}
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto rounded border bg-background p-2 text-[11px] whitespace-pre-wrap">
        {action.output}
      </pre>
    </details>
  );
}

export function PendingText({
  action,
  nodeName,
}: {
  action: ActionRecord;
  nodeName: string;
}) {
  const now = useNow(1_000);
  return (
    <span className="font-mono text-xs">
      <span aria-hidden="true">{actionText(action, nodeName, now)}</span>
      <span className="sr-only">{actionStage(action, nodeName)}</span>
    </span>
  );
}

function MemberControls({
  member,
  onRequest,
}: {
  member: ServiceMember;
  onRequest: (request: ActionRequest) => void;
}) {
  const run = useRunAction();
  const cancel = useCancelActions();
  const target = toTarget(member);
  const name = displayName(member.entry.kind, member.entry.name);
  const action = member.action;
  const primary = primaryAction(member.entry.state);
  const direct = (chosen: ServiceAction) =>
    run.mutate({ action: chosen, mode: "rolling", targets: [target] });
  return (
    <div className="flex items-center justify-end gap-1">
      {action && isPending(action) ? (
        action.status === "queued" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-11 md:h-8"
            onClick={() => cancel.mutate(action.batchId)}
          >
            Cancel
          </Button>
        )
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:h-8"
            disabled={run.isPending}
            aria-label={`${verb(primary)} ${name} on ${member.node.name}`}
            onClick={() => direct(primary)}
          >
            {verb(primary)}
          </Button>
          <RowMenu
            label={`${name} on ${member.node.name} actions`}
            items={[
              ...(member.entry.state === "running"
                ? []
                : [{ label: "Start", onSelect: () => direct("start") }]),
              { label: "Restart", onSelect: () => direct("restart") },
              {
                label: "Stop",
                destructive: true,
                onSelect: () =>
                  onRequest({ action: "stop", targets: [target] }),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

function latestBatch(group: ServiceGroup): ActionRecord[] {
  const actions = group.members
    .map((member) => member.action)
    .filter((action): action is ActionRecord => action !== null);
  const newest = actions.reduce<ActionRecord | null>(
    (latest, action) =>
      !latest || action.requestedAt > latest.requestedAt ? action : latest,
    null,
  );
  return newest
    ? actions.filter((action) => action.batchId === newest.batchId)
    : [];
}

function GroupControls({
  group,
  seen,
  onRequest,
}: {
  group: ServiceGroup;
  seen: number;
  onRequest: (request: ActionRequest) => void;
}) {
  const cancel = useCancelActions();
  const batch = latestBatch(group);
  const name = displayName(group.kind, group.name);
  const ask = (action: ServiceAction) =>
    onRequest({ action, targets: bulkTargets(group, seen) });
  if (batch.some(isPending)) {
    const queued = batch.find((action) => action.status === "queued");
    return queued ? (
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-11 md:h-8"
          onClick={() => cancel.mutate(queued.batchId)}
        >
          Cancel
        </Button>
      </div>
    ) : null;
  }
  const primary = groupPrimary(group);
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-11 md:h-8"
        onClick={() => ask(primary)}
      >
        {verb(primary)} all
      </Button>
      <RowMenu
        label={`${name} actions`}
        items={[
          { label: "Start all", onSelect: () => ask("start") },
          { label: "Restart all", onSelect: () => ask("restart") },
          { label: "Stop all", destructive: true, onSelect: () => ask("stop") },
        ]}
      />
    </div>
  );
}

function LastAction({ member }: { member: ServiceMember }) {
  const action = member.action;
  if (!action) return null;
  return isPending(action) ? (
    <PendingText action={action} nodeName={member.node.name} />
  ) : (
    <ActionOutcome action={action} nodeName={member.node.name} />
  );
}

function GroupProgress({ group }: { group: ServiceGroup }) {
  const batch = latestBatch(group);
  const names = new Map(
    group.members.map((member) => [member.node.id, member.node.name]),
  );
  const text = batchText(batch, (id) => names.get(id) ?? id);
  if (text) return <>{text}</>;
  const pending = group.members.find((member) => isPending(member.action));
  return pending ? <LastAction member={pending} /> : null;
}

export function ServiceList({
  groups,
  seen,
  showServer,
  onRequest,
}: {
  groups: ServiceGroup[];
  seen: number;
  showServer: boolean;
  onRequest: (request: ActionRequest) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {groups.map((group) => {
        const [single] = group.members.length === 1 ? group.members : [];
        const expanded = open.has(group.key);
        const listId = `servers-${group.key.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
        return (
          <li key={group.key}>
            <div
              className={cn(
                ROW,
                "px-3 py-2.5",
                single && offline(single, seen) && "opacity-60",
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                {single ? (
                  <StatusDot tone={TONE[single.entry.state]} />
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 md:size-8"
                    aria-expanded={expanded}
                    aria-controls={listId}
                    aria-label={`${expanded ? "Hide" : "Show"} servers for ${displayName(group.kind, group.name)}`}
                    onClick={() => toggle(group.key)}
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
                <span className="truncate font-medium" title={group.name}>
                  {displayName(group.kind, group.name)}
                </span>
              </div>
              <span className="col-span-2 font-mono text-xs text-muted-foreground md:col-span-1">
                {single
                  ? stateLabel(single, seen, { kind: true, server: showServer })
                  : `${group.kind} · ${running(group)}/${group.members.length} running`}
              </span>
              <span
                className="col-span-2 min-w-0 font-mono text-xs text-muted-foreground md:col-span-1"
                aria-live="polite"
              >
                {single ? (
                  <LastAction member={single} />
                ) : (
                  <GroupProgress group={group} />
                )}
              </span>
              <div className="col-start-2 row-start-1 md:col-start-auto md:row-start-auto">
                {single ? (
                  <MemberControls member={single} onRequest={onRequest} />
                ) : (
                  <GroupControls
                    group={group}
                    seen={seen}
                    onRequest={onRequest}
                  />
                )}
              </div>
            </div>
            {!single && expanded && (
              <ul id={listId} className="divide-y border-t">
                {group.members.map((member) => (
                  <li
                    key={member.node.id}
                    className={cn(
                      ROW,
                      "px-3 py-2",
                      offline(member, seen) && "opacity-60",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2 pl-3 md:pl-10">
                      <StatusDot tone={TONE[member.entry.state]} />
                      <span className="truncate">{member.node.name}</span>
                    </span>
                    <span className="col-span-2 pl-3 font-mono text-xs text-muted-foreground md:col-span-1 md:pl-0">
                      {stateLabel(member, seen, { kind: false, server: false })}
                    </span>
                    <span
                      className="col-span-2 min-w-0 pl-3 font-mono text-xs text-muted-foreground md:col-span-1 md:pl-0"
                      aria-live="polite"
                    >
                      <LastAction member={member} />
                    </span>
                    <div className="col-start-2 row-start-1 md:col-start-auto md:row-start-auto">
                      <MemberControls member={member} onRequest={onRequest} />
                    </div>
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
