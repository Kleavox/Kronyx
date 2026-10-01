import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CheckDialog } from "@/features/checks/check-dialog";
import { useSignedAction } from "@/features/deploy/use-signed-action";
import { useDeleteNode, useServices } from "@/lib/api";
import { canRestartServer } from "@/lib/devices";
import type { NodeRecord } from "@/types";

import { EditNodeDialog } from "./edit-node-dialog";

type OpenDialog = "add-check" | "edit" | "delete" | "restart" | null;

export function NodeActions({
  node,
  onDeleted,
  restart = false,
  onRestartClosed,
}: {
  node: NodeRecord;
  onDeleted?: () => void;
  restart?: boolean;
  onRestartClosed?: () => void;
}) {
  const [dialog, setDialog] = useState<OpenDialog>(restart ? "restart" : null);
  const remove = useDeleteNode();
  const reboot = useSignedAction(false);
  const services = useServices();
  const trust =
    services.data?.nodes.find((entry) => entry.id === node.id)?.trust ?? null;
  const restartable = canRestartServer(node, trust);

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Actions
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDialog("add-check")}>
            Add check
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog("edit")}>
            Rename node
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {restartable && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDialog("restart")}
            >
              Restart server
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDialog("delete")}
          >
            Delete node
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CheckDialog
        open={dialog === "add-check"}
        onOpenChange={(open) => setDialog(open ? "add-check" : null)}
        nodeId={node.id}
      />

      <EditNodeDialog
        key={`${node.name}:${node.interval_seconds}`}
        node={node}
        open={dialog === "edit"}
        onOpenChange={(open) => setDialog(open ? "edit" : null)}
      />

      <ConfirmDialog
        open={dialog === "restart" && restartable}
        onOpenChange={(open) => {
          setDialog(open ? "restart" : null);
          if (!open) onRestartClosed?.();
        }}
        title={`Restart ${node.name}?`}
        description="The server goes offline for a minute or two. Services that don't start on boot stay stopped."
        confirmLabel="Restart server"
        mutation={reboot}
        variables={{
          action: "reboot",
          targets: [{ nodeId: node.id, kind: "host", name: "server" }],
        }}
      />

      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        title={`Delete ${node.name}?`}
        description="Its metrics, checks, check results and incidents are deleted with it, and the agent on the server stops being accepted."
        confirmLabel="Delete node"
        mutation={remove}
        variables={node.id}
        onDone={onDeleted}
      />
    </>
  );
}
