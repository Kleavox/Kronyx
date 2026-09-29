import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { newlyFinished, outcomeText } from "@/lib/services";
import type { ActionRecord, NodeRecord } from "@/types";

export function useActionToasts(
  actions: ActionRecord[] | undefined,
  nodes: NodeRecord[],
) {
  const previous = useRef<ActionRecord[] | undefined>(undefined);
  useEffect(() => {
    if (actions && previous.current) {
      const names = new Map(nodes.map((node) => [node.id, node.name]));
      for (const action of newlyFinished(previous.current, actions)) {
        const outcome = outcomeText(
          action,
          names.get(action.nodeId) ?? "its server",
        );
        if (outcome?.ok) toast.success(outcome.text);
        else if (outcome) toast.error(outcome.text);
      }
    }
    previous.current = actions;
  }, [actions, nodes]);
}
