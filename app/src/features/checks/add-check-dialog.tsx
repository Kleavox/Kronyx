import { useState, type FormEvent } from "react";
import { errorMessage } from "@/lib/http";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateCheck } from "@/lib/api";
import type { CheckKind, NodeRecord } from "@/types";

const PLACEHOLDER: Record<CheckKind, string> = {
  HTTP: "https://example.com/health",
  TCP: "127.0.0.1:5432",
  SERVICE: "nginx.service",
};

export function AddCheckDialog({
  open,
  onOpenChange,
  nodeId,
  nodes = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeId?: string;
  nodes?: NodeRecord[];
}) {
  const [chosenNode, setChosenNode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CheckKind>("HTTP");
  const [target, setTarget] = useState("");
  const create = useCreateCheck();
  const targetNode = nodeId ?? chosenNode;

  const close = (next: boolean) => {
    if (!next) {
      setName("");
      setTarget("");
      setKind("HTTP");
      create.reset();
    }
    onOpenChange(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { nodeId: targetNode, name: name.trim(), kind, target: target.trim() },
      { onSuccess: () => close(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form className="space-y-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add check</DialogTitle>
            <DialogDescription>
              The agent on the node runs it on every cycle.
            </DialogDescription>
          </DialogHeader>
          {!nodeId && (
            <Field id="check-node" label="Node">
              <Select value={chosenNode} onValueChange={setChosenNode}>
                <SelectTrigger id="check-node" className="w-full">
                  <SelectValue placeholder="Choose a node" />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field id="check-name" label="Check name">
            <Input
              id="check-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Public API"
              maxLength={100}
              required
            />
          </Field>
          <Field id="check-kind" label="Check kind">
            <Select
              value={kind}
              onValueChange={(value) => setKind(value as CheckKind)}
            >
              <SelectTrigger id="check-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="HTTP">HTTP</SelectItem>
                <SelectItem value="TCP">TCP</SelectItem>
                <SelectItem value="SERVICE">Systemd</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="check-target" label="Check target">
            <Input
              id="check-target"
              className="font-mono"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={PLACEHOLDER[kind]}
              maxLength={2048}
              required
            />
          </Field>
          {create.error && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(create.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !targetNode}>
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
