import { clockTime } from "@/lib/format";
import {
  duringIncident,
  heartbeatSummary,
  layoutReportSlots,
  type SlotState,
} from "@/lib/series";
import { cn } from "@/lib/utils";
import type { CheckResult, Incident } from "@/types";

const SLOT_CLASS: Record<SlotState, string> = {
  received: "bg-success/85",
  missed: "bg-destructive",
  pending: "bg-border",
  none: "bg-border/50",
};

const SLOT_LABEL: Record<SlotState, string> = {
  received: "reported",
  missed: "no report",
  pending: "waiting",
  none: "not enrolled",
};

export function ReportStrip({
  states,
  starts,
  className,
}: {
  states: SlotState[];
  starts?: number[];
  className?: string;
}) {
  const received = states.filter((state) => state === "received").length;
  const missed = states.filter((state) => state === "missed").length;
  return (
    <div
      role="img"
      aria-label={`${received} windows with reports, ${missed} missed, in the last ${states.length} history windows`}
      className={cn("flex h-3.5 gap-0.5", className)}
    >
      {states.map((state, index) => (
        <span
          key={index}
          data-tip={
            starts?.[index] === undefined
              ? undefined
              : `${clockTime(starts[index])} · ${SLOT_LABEL[state]}`
          }
          className={cn("bar-tip flex-1 rounded-[2px]", SLOT_CLASS[state])}
        />
      ))}
    </div>
  );
}

function windowTitle(
  start: number,
  result: CheckResult | null,
  brief: boolean,
): string {
  if (!result) return `${clockTime(start)} · no result`;
  return [
    clockTime(start),
    brief ? "DOWN, no incident" : result.status,
    result.latencyMs === null ? "--" : `${result.latencyMs}ms`,
    result.message ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function newestLatency(
  history: { results: CheckResult[] } | undefined,
): string {
  const latency = history?.results.at(-1)?.latencyMs ?? null;
  return latency === null ? "--" : `${latency}ms`;
}

function spanText(seconds: number): string {
  return seconds % 3600 === 0
    ? `${seconds / 3600} hours`
    : `${seconds / 60} minutes`;
}

export function HeartbeatStrip({
  results,
  incidents,
  windowSeconds,
  graceSeconds,
  now,
  asOf,
  count = 48,
  className,
}: {
  results: CheckResult[] | undefined;
  incidents: Pick<Incident, "started_at" | "resolved_at">[];
  windowSeconds: number;
  graceSeconds: number;
  now: number;
  asOf: number | undefined;
  count?: number;
  className?: string;
}) {
  const laid = layoutReportSlots({
    slots: results ?? [],
    slotSeconds: windowSeconds,
    graceSeconds,
    since: 0,
    now,
    asOf,
    count,
  });
  const summary = heartbeatSummary(
    laid.map((slot) => slot.sample?.status ?? null),
    spanText(count * windowSeconds),
  );
  const brief = (start: number, result: CheckResult | null) =>
    result?.status === "DOWN" &&
    !duringIncident(start, windowSeconds * 1000, incidents);
  return (
    <div
      role="img"
      aria-label={summary}
      className={cn("flex h-[18px] min-w-0 gap-0.5", className)}
    >
      {laid.map((slot) => (
        <span
          key={slot.start}
          data-tip={windowTitle(
            slot.start,
            slot.sample,
            brief(slot.start, slot.sample),
          )}
          className={cn(
            "bar-tip flex-1 rounded-[2px]",
            !slot.sample
              ? "bg-border"
              : slot.sample.status === "UP"
                ? "bg-success/85"
                : brief(slot.start, slot.sample)
                  ? "bg-warning"
                  : "bg-destructive",
          )}
        />
      ))}
    </div>
  );
}
