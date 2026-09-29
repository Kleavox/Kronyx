import {
  CircleArrowUp,
  CircleCheck,
  CircleX,
  LoaderCircle,
} from "lucide-react";

import { CopyCommand } from "@/components/copy-command";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  useCheckAgentRelease,
  useRequestAgentUpdate,
  useUpdateNode,
} from "@/lib/api";
import { agentState } from "@/lib/agent";
import { timeAgo } from "@/lib/format";
import type { AgentRelease, NodeRecord } from "@/types";

export function AgentPanel({
  node,
  release,
  now,
}: {
  node: NodeRecord;
  release: AgentRelease;
  now: number;
}) {
  const state = agentState(node, release.version, now);
  const request = useRequestAgentUpdate();
  const check = useCheckAgentRelease();
  const settings = useUpdateNode();
  const target = node.update_requested_version ?? release.version;

  return (
    <section
      aria-labelledby="node-agent"
      className="rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="node-agent"
          className="text-[11px] tracking-wider text-muted-foreground uppercase"
        >
          Agent
        </h2>
        <p className="font-mono text-[11px] text-muted-foreground">
          {release.version ? `latest ${release.version}` : "latest unknown"}
          {release.checkedAt && ` · checked ${timeAgo(release.checkedAt, now)}`}
        </p>
      </div>
      <p className="mt-2 font-mono text-xl">{node.agent_version ?? "--"}</p>

      <div className="mt-3 space-y-3 text-sm">
        {state === "current" && (
          <p className="flex items-center gap-2 text-success">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
            Up to date.
          </p>
        )}
        {state === "available" && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex items-center gap-2">
              <CircleArrowUp
                aria-hidden="true"
                className="size-4 shrink-0 text-primary"
              />
              <span>
                Version <span className="font-mono">{target}</span> is
                available.
              </span>
            </p>
            <Button
              size="sm"
              onClick={() => request.mutate(node.id)}
              disabled={request.isPending}
            >
              {request.isPending ? "Requesting…" : "Update agent"}
            </Button>
          </div>
        )}
        {state === "updating" && (
          <p role="status" className="flex items-start gap-2 text-primary">
            <LoaderCircle
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin"
            />
            <span>
              Updating to <span className="font-mono">{target}</span>. The agent
              restarts on its own after its next report.
            </span>
          </p>
        )}
        {state === "failed" && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex items-start gap-2 text-destructive">
              <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                The update to <span className="font-mono">{target}</span> did
                not finish in 10 minutes.
              </span>
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => request.mutate(node.id)}
              disabled={request.isPending}
            >
              Retry
            </Button>
          </div>
        )}
        {state === "unknown" && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-muted-foreground">
              Krynodes has not checked for agent releases yet.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => check.mutate()}
              disabled={check.isPending}
            >
              {check.isPending ? "Checking…" : "Check now"}
            </Button>
          </div>
        )}
      </div>

      <label className="mt-4 flex min-h-11 cursor-pointer items-center justify-between gap-4 border-t pt-3 md:min-h-0">
        <span>
          <span className="block text-sm">Update automatically</span>
          <span className="block text-xs text-muted-foreground">
            Installs each new release as soon as Krynodes sees it.
          </span>
        </span>
        <Switch
          checked={Boolean(node.auto_update)}
          disabled={settings.isPending}
          onCheckedChange={(checked) =>
            settings.mutate({ id: node.id, autoUpdate: checked })
          }
        />
      </label>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Update by hand
        </summary>
        <div className="mt-2">
          <CopyCommand command={release.updateCommand} />
        </div>
      </details>
    </section>
  );
}
