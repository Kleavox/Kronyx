import { useState } from "react";

import { useServices } from "@/lib/api";
import { groupStacks } from "@/lib/stacks";
import type { NodeRecord } from "@/types";

import { DeployDialog, type DeployRequest } from "./deploy-dialog";
import { StackList } from "./stack-list";

export function NodeStacks({ node, seen }: { node: NodeRecord; seen: number }) {
  const services = useServices();
  const [request, setRequest] = useState<DeployRequest | null>(null);
  if (!services.data) return null;
  const groups = groupStacks(services.data, [node], "");
  if (groups.length === 0) return null;
  const entry = services.data.nodes.find((item) => item.id === node.id);
  return (
    <section aria-labelledby="node-stacks">
      <div className="mb-2 flex min-h-8 items-center gap-2">
        <h2
          id="node-stacks"
          className="text-[11px] tracking-wider text-muted-foreground uppercase"
        >
          Stacks on this node · {groups.length}
        </h2>
      </div>
      <StackList
        groups={groups}
        seen={seen}
        showServer={false}
        services={new Map([[node.id, entry?.services ?? []]])}
        onRequest={setRequest}
      />
      <DeployDialog
        request={request}
        seen={seen}
        onClose={() => setRequest(null)}
      />
    </section>
  );
}
