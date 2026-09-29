import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useNodeActions, useRefreshServices, useServices } from "@/lib/api";
import { clockTime } from "@/lib/format";
import {
  displayName,
  durationText,
  groupServices,
  isPending,
  refreshPending,
  verb,
} from "@/lib/services";
import type { NodeRecord } from "@/types";

import { ActionDialog, type ActionRequest } from "./action-dialog";
import { ActionOutcome, PendingText, ServiceList } from "./service-list";

const SECTION_TITLE =
  "text-[11px] tracking-wider text-muted-foreground uppercase";

export function NodeServices({
  node,
  seen,
}: {
  node: NodeRecord;
  seen: number;
}) {
  const services = useServices();
  const refresh = useRefreshServices();
  const [request, setRequest] = useState<ActionRequest | null>(null);
  const groups = services.data
    ? groupServices(services.data, [node], {
        showSystem: false,
        query: "",
        notRunning: false,
      })
    : [];
  const refreshing =
    services.data?.nodes.some(
      (entry) =>
        entry.id === node.id && refreshPending(entry, services.dataUpdatedAt),
    ) ?? false;
  return (
    <section aria-labelledby="node-services">
      <div className="mb-2 flex min-h-8 items-center gap-2">
        <h2 id="node-services" className={SECTION_TITLE}>
          Services on this node · {groups.length}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-11 md:h-8"
          disabled={refresh.isPending || refreshing}
          onClick={() => refresh.mutate([node.id])}
        >
          <RefreshCw aria-hidden="true" />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          {services.data
            ? "No services reported yet. They appear within five minutes of enrolling."
            : "Loading services…"}
        </p>
      ) : (
        <ServiceList
          groups={groups}
          seen={seen}
          showServer={false}
          onRequest={setRequest}
        />
      )}
      <ActionDialog request={request} onClose={() => setRequest(null)} />
    </section>
  );
}

export function RecentActions({ node }: { node: NodeRecord }) {
  const actions = useNodeActions(node.id);
  const list = actions.data?.actions ?? [];
  return (
    <section aria-labelledby="node-recent-actions">
      <h2 id="node-recent-actions" className={`mb-2 ${SECTION_TITLE}`}>
        Recent actions
      </h2>
      {list.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          {actions.data ? "No actions yet." : "Loading actions…"}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {list.map((action) => {
            const duration = durationText(action);
            return (
              <li
                key={action.id}
                className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-3 py-2.5 text-sm sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]"
              >
                <span className="font-mono text-xs leading-5 text-muted-foreground">
                  {clockTime(action.requestedAt)}
                </span>
                <span className="min-w-0 truncate">
                  {verb(action.action)} {displayName(action.kind, action.name)}
                </span>
                <span className="col-start-2 flex min-w-0 flex-wrap items-baseline gap-x-1 font-mono text-xs text-muted-foreground sm:col-start-auto sm:justify-end">
                  {isPending(action) ? (
                    <PendingText action={action} nodeName={node.name} />
                  ) : (
                    <ActionOutcome action={action} nodeName={node.name} />
                  )}
                  {duration && <span>· {duration}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
