import { Link } from "react-router";

import { clockTime } from "@/lib/format";
import {
  heartbeatSummary,
  incidentDuring,
  layoutReportSlots,
  slotTip,
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
  incidents: Pick<Incident, "id" | "started_at" | "resolved_at">[];
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
  return (
    <div
      role="group"
      aria-label={summary}
      className={cn("flex h-[18px] min-w-0 gap-0.5", className)}
    >
      {laid.map((slot) => {
        const down = slot.sample?.status === "DOWN";
        const incident = down
          ? incidentDuring(slot.start, windowSeconds * 1000, incidents)
          : undefined;
        const tip = slotTip(
          slot.start,
          slot.sample,
          down && !incident,
          clockTime,
        );
        const tone = cn(
          "bar-tip flex-1 rounded-[2px]",
          !slot.sample
            ? "bg-border"
            : !down
              ? "bg-success/85"
              : incident
                ? "bg-destructive"
                : "bg-warning",
        );
        return incident ? (
          <Link
            key={slot.start}
            to={`/incidents/${incident.id}`}
            data-tip={tip}
            aria-label={`${tip}. Open the incident`}
            className={tone}
          />
        ) : (
          <span key={slot.start} data-tip={tip} className={tone} />
        );
      })}
    </div>
  );
}
