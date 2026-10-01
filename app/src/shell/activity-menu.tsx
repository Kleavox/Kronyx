import { Check, History, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { Elapsed } from "@/components/node-status";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useOverview, useServices } from "@/lib/api";
import { clockTime } from "@/lib/format";
import { activity, type ActivityItem } from "@/lib/operations";
import { outcomeText, runningText } from "@/lib/services";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const ROW =
  "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent";

function Running({ item, onPick }: { item: ActivityItem; onPick: () => void }) {
  return (
    <li>
      <Link to={`/nodes/${item.nodeId}`} onClick={onPick} className={ROW}>
        <StatusDot tone="warn" pulse className="mt-1.5" />
        <span className="min-w-0">
          <span className="block truncate">
            {runningText(item.action, item.nodeName)}
          </span>
          <span className="block font-mono text-[11px] text-muted-foreground">
            {item.by} · <Elapsed since={item.at} />
            {item.status === "queued" && " · waiting"}
          </span>
        </span>
      </Link>
    </li>
  );
}

function Finished({
  item,
  onPick,
}: {
  item: ActivityItem;
  onPick: () => void;
}) {
  const outcome = outcomeText(item.action, item.nodeName);
  if (!outcome) return null;
  const Icon = outcome.ok ? Check : X;
  return (
    <li>
      <Link to={`/nodes/${item.nodeId}`} onClick={onPick} className={ROW}>
        <Icon
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-3.5",
            outcome.ok ? "text-success" : "text-destructive",
          )}
        />
        <span className="min-w-0">
          <span
            className={cn("block truncate", !outcome.ok && "text-destructive")}
          >
            {outcome.text}
          </span>
          <span className="block font-mono text-[11px] text-muted-foreground">
            {item.by} · {clockTime(item.at)}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function ActivityMenu() {
  const services = useServices();
  const overview = useOverview();
  const [open, setOpen] = useState(false);
  const now = useNow(open ? 5_000 : 30_000);
  const list = activity(
    services.data?.actions ?? [],
    overview.data?.nodes ?? [],
    now,
  );
  const running = list.running.length;
  const close = () => setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={
            running > 0 ? `Activity, ${running} in progress` : "Activity"
          }
          className={cn(running > 0 && "border-warning/40")}
        >
          {running > 0 ? (
            <>
              <StatusDot tone="warn" pulse />
              <span className="font-mono text-xs">
                {running}
                <span className="hidden md:inline"> in progress</span>
              </span>
            </>
          ) : (
            <History aria-hidden="true" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[70dvh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto p-2"
      >
        <h2 className="px-2 pt-1 pb-1.5 text-[11px] tracking-wider text-muted-foreground uppercase">
          In progress
        </h2>
        {running === 0 ? (
          <p className="px-2 pb-2 text-sm text-muted-foreground">
            Nothing is running.
          </p>
        ) : (
          <ul>
            {list.running.map((item) => (
              <Running key={item.id} item={item} onPick={close} />
            ))}
          </ul>
        )}
        <h2 className="mt-1 border-t px-2 pt-2.5 pb-1.5 text-[11px] tracking-wider text-muted-foreground uppercase">
          Last hour
        </h2>
        {list.recent.length === 0 ? (
          <p className="px-2 pb-1 text-sm text-muted-foreground">
            No actions in the last hour.
          </p>
        ) : (
          <ul>
            {list.recent.map((item) => (
              <Finished key={item.id} item={item} onPick={close} />
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
