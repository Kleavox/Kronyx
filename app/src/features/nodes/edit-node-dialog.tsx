import { useState } from "react";

import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useUpdateNode } from "@/lib/api";
import { errorMessage } from "@/lib/http";
import type { NodeRecord } from "@/types";

export function EditNodeDialog({
  node,
  open,
  onOpenChange,
}: {
  node: NodeRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(node.name);
  const save = useUpdateNode();
  const close = (next: boolean) => {
    if (!next) {
      setName(node.name);
      save.reset();
    }
    onOpenChange(next);
  };

  const trimmed = name.trim();
  const changed = trimmed !== "" && trimmed !== node.name;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(
              { id: node.id, name: trimmed },
              { onSuccess: () => onOpenChange(false) },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {node.name}</DialogTitle>
            <DialogDescription>
              Every server reports once a minute.
            </DialogDescription>
          </DialogHeader>
          <Field id="node-name" label="Name">
            <Input
              id="node-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
            />
          </Field>
          {save.error && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(save.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !changed}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
