import { useSyncExternalStore } from "react";

import { openSession, sessionSnapshot, subscribe } from "@/lib/deploy-session";

export function useDeploySession() {
  const state = useSyncExternalStore(
    subscribe,
    sessionSnapshot,
    sessionSnapshot,
  );
  return { state, open: openSession };
}
