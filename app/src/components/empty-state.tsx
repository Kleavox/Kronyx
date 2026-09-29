import type { ReactNode } from "react";

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center">
      <h2 className="font-medium">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
        {body}
      </p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
