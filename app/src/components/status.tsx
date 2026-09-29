import type { CheckDisplay, NodeState } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tone = "ok" | "bad" | "warn" | "idle";

const TONE: Record<Tone, string> = {
  ok: "bg-success",
  bad: "bg-destructive",
  warn: "bg-warning",
  idle: "bg-muted-foreground",
};

export function nodeTone(state: NodeState): Tone {
  if (state === "online") return "ok";
  if (state === "offline") return "bad";
  if (state === "pending") return "warn";
  return "idle";
}

export function checkTone(status: CheckDisplay): Tone {
  if (status === "UP") return "ok";
  if (status === "DOWN") return "bad";
  return "idle";
}

export function StatusDot({
  tone,
  className,
}: {
  tone: Tone;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        TONE[tone],
        className,
      )}
    />
  );
}

export function StatusChip({
  tone,
  label,
  detail,
}: {
  tone: Tone;
  label: string;
  detail?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
      <StatusDot tone={tone} />
      <span className="text-foreground">{label}</span>
      {detail && <span>· {detail}</span>}
    </span>
  );
}
