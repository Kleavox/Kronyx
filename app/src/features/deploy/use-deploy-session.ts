import { useSyncExternalStore } from "react";

import {
  activeSession,
  endSession,
  sessionSnapshot,
  startSession,
  subscribe,
  withPrompt,
} from "@/lib/deploy-session";
import {
  createSession,
  grantVerified,
  type Proof,
  type Session,
} from "@/lib/passkeys";

export function useDeploySession() {
  const state = useSyncExternalStore(
    subscribe,
    sessionSnapshot,
    sessionSnapshot,
  );
  const open = async (
    devices: string[],
    prove: Proof = null,
  ): Promise<Session> => {
    const current = activeSession();
    if (
      current &&
      devices.includes(current.grant.credentialId) &&
      (prove !== "fingerprint" || grantVerified(current))
    ) {
      return current;
    }
    const session = await withPrompt(() =>
      createSession(devices, window.location.hostname, prove),
    );
    startSession(session);
    return session;
  };
  return { state, open, lock: endSession };
}
