import type { ReactNode } from "react";

export function PageHeader({
  title,
  crumb,
  meta,
  actions,
}: {
  title: string;
  crumb?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5">
      {crumb && (
        <div className="mb-1 truncate text-xs text-muted-foreground">
          {crumb}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">
          {title}
        </h1>
        {meta}
        {actions && (
          <div className="flex flex-wrap items-center gap-2 md:ml-auto">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
