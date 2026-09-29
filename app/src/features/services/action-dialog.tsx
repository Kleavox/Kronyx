import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useRunAction } from "@/lib/api";
import { errorMessage } from "@/lib/http";
import { displayName, verb, type ActionTarget } from "@/lib/services";
import type { BatchMode, ServiceAction } from "@/types";

export interface ActionRequest {
  action: ServiceAction;
  targets: ActionTarget[];
}

const MODES: { value: BatchMode; label: string; detail: string }[] = [
  {
    value: "rolling",
    label: "One at a time (recommended)",
    detail:
      "The next server goes after the previous one succeeds; the rest stop at the first failure.",
  },
  {
    value: "parallel",
    label: "All at once",
    detail: "Every server runs it at its next report.",
  },
];

export function ActionDialog({
  request,
  onClose,
}: {
  request: ActionRequest | null;
  onClose: () => void;
}) {
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      {request && request.targets.length > 0 && (
        <ActionForm request={request} onClose={onClose} />
      )}
    </AlertDialog>
  );
}

function ActionForm({
  request,
  onClose,
}: {
  request: ActionRequest;
  onClose: () => void;
}) {
  const run = useRunAction(false);
  const [mode, setMode] = useState<BatchMode>("rolling");
  const [first] = request.targets;
  const several = request.targets.length > 1;
  const name = first ? displayName(first.kind, first.name) : "";
  const title = several
    ? `${verb(request.action)} ${name} on ${request.targets.length} servers?`
    : `${verb(request.action)} ${name} on ${first?.nodeName ?? ""}?`;
  return (
    <AlertDialogContent className="max-sm:top-auto max-sm:bottom-0 max-sm:translate-y-0 max-sm:rounded-b-none">
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>
          {request.action === "stop"
            ? "It stays stopped until you start it."
            : "Each server runs it at its next report, within about a minute."}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {several && (
        <>
          <ul className="max-h-32 overflow-y-auto rounded-md border px-3 py-2 font-mono text-xs">
            {request.targets.map((target) => (
              <li key={target.nodeId}>
                {target.nodeName}
                {target.offline && (
                  <span className="text-muted-foreground"> · offline</span>
                )}
              </li>
            ))}
          </ul>
          {request.targets.some((target) => target.offline) && (
            <p className="text-sm text-muted-foreground">
              Offline servers run last. One at a time stops at the first one
              that does not answer within 10 minutes.
            </p>
          )}
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Order</legend>
            {MODES.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="order"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-muted-foreground">
                    {option.detail}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </>
      )}
      {run.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(run.error)}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button
          variant={request.action === "stop" ? "destructive" : "default"}
          disabled={run.isPending}
          onClick={() =>
            run.mutate(
              { action: request.action, mode, targets: request.targets },
              { onSuccess: onClose },
            )
          }
        >
          {run.isPending ? "Working…" : verb(request.action)}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
