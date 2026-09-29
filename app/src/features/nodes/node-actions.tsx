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
import { AddCheckDialog } from "@/features/checks/add-check-dialog";
import { useDeleteNode } from "@/lib/api";
import type { NodeRecord } from "@/types";

import { EditNodeDialog } from "./edit-node-dialog";

type OpenDialog = "add-check" | "edit" | "delete" | null;

export function NodeActions({
  node,
  onDeleted,
}: {
  node: NodeRecord;
  onDeleted?: () => void;
}) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const remove = useDeleteNode();

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
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDialog("delete")}
          >
            Delete node
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AddCheckDialog
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
