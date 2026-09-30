import { Link } from "react-router";

import { RowMenu } from "@/components/row-menu";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { useSignedAction } from "@/features/deploy/use-signed-action";
import { useCancelActions } from "@/lib/api";
import { nodeState } from "@/lib/format";
import {
  actionText,
  displayName,
  isPending,
  primaryAction,
  toTarget,
  verb,
  type ServerGroup,
  type ServiceMember,
} from "@/lib/services";
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
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_7.5rem]";

const offline = (member: ServiceMember, seen: number) =>
  nodeState(member.node, seen) === "offline";

function stateLabel(member: ServiceMember): string {
  return `${member.entry.kind} · ${member.entry.state}`;
}

export function ActionOutcome({
  action,
  nodeName,
}: {
  action: ActionRecord;
  nodeName: string;
}) {
  const text = actionText(action, nodeName);
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
  return (
    <span className="font-mono text-xs">{actionText(action, nodeName)}</span>
  );
}

function MemberControls({
  member,
  onRequest,
}: {
  member: ServiceMember;
  onRequest: (request: ActionRequest) => void;
}) {
  const run = useSignedAction();
  const cancel = useCancelActions();
  const target = toTarget(member);
  const name = displayName(member.entry.kind, member.entry.name);
  const action = member.action;
  const primary = primaryAction(member.entry.state);
  const direct = (chosen: ServiceAction) =>
    run.mutate({ action: chosen, targets: [target] });
  if (action && isPending(action)) {
    return action.status === "queued" ? (
      <Button
        variant="ghost"
        size="sm"
        className="h-8"
        onClick={() => cancel.mutate(action.batchId)}
      >
        Cancel
      </Button>
    ) : null;
  }
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="outline"
        size="sm"
        className="h-8"
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
            onSelect: () => onRequest({ action: "stop", target }),
          },
        ]}
      />
    </div>
  );
}

export function ServiceRows({
  members,
  seen,
  trusted,
  onRequest,
}: {
  members: ServiceMember[];
  seen: number;
  trusted: boolean;
  onRequest: (request: ActionRequest) => void;
}) {
  return (
    <ul className="divide-y">
      {members.map((member) => {
        const label = stateLabel(member);
        return (
          <li
            key={`${member.entry.kind}:${member.entry.name}`}
            className={cn(ROW, offline(member, seen) && "opacity-60")}
          >
            <span className="flex min-h-8 min-w-0 items-center gap-2">
              <StatusDot tone={TONE[member.entry.state]} />
              <span className="truncate font-medium" title={member.entry.name}>
                {displayName(member.entry.kind, member.entry.name)}
              </span>
            </span>
            <span
              className="col-span-2 truncate font-mono text-xs text-muted-foreground md:col-span-1"
              title={label}
            >
              {label}
            </span>
            <span
              className="col-span-2 min-w-0 truncate font-mono text-xs text-muted-foreground empty:hidden md:col-span-1 md:empty:block"
              aria-live="polite"
            >
              {member.action &&
                (isPending(member.action) ? (
                  <PendingText
                    action={member.action}
                    nodeName={member.node.name}
                  />
                ) : (
                  <ActionOutcome
                    action={member.action}
                    nodeName={member.node.name}
                  />
                ))}
            </span>
            <div className="col-start-2 row-start-1 md:col-start-auto md:row-start-auto">
              {trusted && (
                <MemberControls member={member} onRequest={onRequest} />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function TrustLink() {
  return (
    <Link
      to="/devices"
      className="font-mono text-xs text-warning underline-offset-4 hover:underline"
    >
      Not trusted yet
    </Link>
  );
}

export function ServerServiceList({
  groups,
  seen,
  onRequest,
}: {
  groups: ServerGroup[];
  seen: number;
  onRequest: (request: ActionRequest) => void;
}) {
  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const down = group.members.filter(
          (member) => member.entry.state !== "running",
        ).length;
        const away = nodeState(group.node, seen) === "offline";
        const count = group.members.length;
        return (
          <section
            key={group.node.id}
            aria-labelledby={`server-${group.node.id}`}
            className="rounded-lg border bg-card"
          >
            <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-3 py-2">
              <StatusDot tone={away ? "idle" : "ok"} />
              <h2
                id={`server-${group.node.id}`}
                className="min-w-0 truncate font-medium"
              >
                <Link
                  to={`/nodes/${group.node.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {group.node.name}
                </Link>
              </h2>
              <span className="font-mono text-xs text-muted-foreground">
                {count} {count === 1 ? "service" : "services"}
                {down > 0 && ` · ${down} not running`}
                {away && " · offline"}
              </span>
              {!group.trusted && (
                <span className="ml-auto">
                  <TrustLink />
                </span>
              )}
            </div>
            <ServiceRows
              members={group.members}
              seen={seen}
              trusted={group.trusted}
              onRequest={onRequest}
            />
          </section>
        );
      })}
    </div>
  );
}
