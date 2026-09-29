import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { newlyFinished, outcomeText } from "@/lib/services";
import type { ActionRecord, NodeRecord } from "@/types";

export function useActionToasts(
  actions: ActionRecord[] | undefined,
  nodes: NodeRecord[],
) {
  const previous = useRef<ActionRecord[] | undefined>(undefined);
  const navigate = useNavigate();
  useEffect(() => {
    if (actions && previous.current) {
      const names = new Map(nodes.map((node) => [node.id, node.name]));
      for (const action of newlyFinished(previous.current, actions)) {
        const outcome = outcomeText(
          action,
          names.get(action.nodeId) ?? "its server",
        );
        if (outcome?.ok) toast.success(outcome.text);
        else if (outcome && action.kind === "compose") {
          const step = action.output?.split("\n")[0];
          const kept =
            action.action === "deploy" &&
            !action.output?.startsWith("pull failed");
          toast.error(outcome.text, {
            description: step,
            duration: 15_000,
            action: kept
              ? {
                  label: "Roll back",
                  onClick: () =>
                    void navigate(
                      `/services?view=stacks&rollback=${encodeURIComponent(action.name)}&node=${action.nodeId}`,
                    ),
                }
              : undefined,
            cancel: {
              label: "Details",
              onClick: () => void navigate(`/nodes/${action.nodeId}`),
            },
          });
        } else if (outcome) toast.error(outcome.text);
      }
    }
    previous.current = actions;
  }, [actions, nodes, navigate]);
}
