import { useSyncExternalStore } from "react";

import {
  activeSession,
  endSession,
  sessionSnapshot,
  startSession,
  subscribe,
  withPrompt,
} from "@/lib/deploy-session";
import { createSession, type Session } from "@/lib/passkeys";

export function useDeploySession() {
  const state = useSyncExternalStore(
    subscribe,
    sessionSnapshot,
    sessionSnapshot,
  );
  const open = async (devices: string[]): Promise<Session> => {
    const current = activeSession();
    if (current && devices.includes(current.grant.credentialId)) {
      return current;
    }
    const session = await withPrompt(() =>
      createSession(devices, window.location.hostname),
    );
    startSession(session);
    return session;
  };
  return { state, open, lock: endSession };
}
