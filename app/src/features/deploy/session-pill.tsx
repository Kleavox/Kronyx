import { Lock, LockOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { remaining, takeEndReason, type Clock } from "@/lib/deploy-session";
import { countdown } from "@/lib/format";
import { useNow } from "@/lib/use-now";

import { useDeploySession } from "./use-deploy-session";

const SLEPT = "Deploy session ended while the tab was hidden.";

function Pill({ clock, onLock }: { clock: Clock; onLock: () => void }) {
  const now = useNow(1_000);
  return (
    <div className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-0.5 pr-0.5 pl-2 text-xs text-primary">
      <LockOpen aria-hidden="true" className="size-3.5" />
      <span className="hidden sm:inline">Deploy unlocked ·</span>
      <span aria-hidden="true" className="font-mono tabular-nums">
        {countdown(remaining(clock, now))}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-9 rounded-full text-primary md:size-6"
        aria-label="Lock deploy"
        onClick={onLock}
      >
        <Lock aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}

export function SessionPill() {
  const { state, lock } = useDeploySession();
  const [announcement, setAnnouncement] = useState("");
  const pending = useRef(false);
  const open = state !== null;

  useEffect(() => {
    if (open) {
      setAnnouncement("Deploy unlocked for 15 minutes.");
      return;
    }
    const reason = takeEndReason();
    if (!reason) return;
    setAnnouncement("Deploy locked.");
    if (reason !== "slept") return;
    if (document.visibilityState === "visible") toast.info(SLEPT);
    else pending.current = true;
  }, [open]);

  useEffect(() => {
    const onShow = () => {
      if (pending.current && document.visibilityState === "visible") {
        pending.current = false;
        toast.info(SLEPT);
      }
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, []);

  return (
    <>
      <span role="status" className="sr-only">
        {announcement}
      </span>
      {state && <Pill clock={state.clock} onLock={lock} />}
    </>
  );
}
