import type { UseMutationResult } from "@tanstack/react-query";
import { errorMessage } from "@/lib/http";

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

export function ConfirmDialog<TData, TVariables>({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  mutation,
  variables,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  mutation: UseMutationResult<TData, Error, TVariables>;
  variables: TVariables;
  onDone?: () => void;
}) {
  const close = (next: boolean) => {
    if (!next) mutation.reset();
    onOpenChange(next);
  };
  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {mutation.error && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(variables, {
                onSuccess: () => {
                  close(false);
                  onDone?.();
                },
              })
            }
          >
            {mutation.isPending ? "Working…" : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
