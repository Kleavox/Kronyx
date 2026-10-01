import {
  SESSION_MS,
  createSession,
  grantVerified,
  type Proof,
  type Session,
} from "./passkeys";

export { SESSION_MS };
export const HIDDEN_LIMIT_MS = 2 * 60_000;

export interface Clock {
  expiresAt: number;
  hiddenSince: number | null;
  prompting: boolean;
}

export function start(
  expiresAt: number,
  isHidden: boolean,
  now: number,
): Clock {
  return { expiresAt, hiddenSince: isHidden ? now : null, prompting: false };
}

export function alive(clock: Clock, now: number): boolean {
  if (now >= clock.expiresAt) return false;
  return (
    clock.prompting ||
    clock.hiddenSince === null ||
    now - clock.hiddenSince < HIDDEN_LIMIT_MS
  );
}

export function hidden(clock: Clock, now: number): Clock {
  if (clock.prompting) return { ...clock, hiddenSince: null };
  return { ...clock, hiddenSince: clock.hiddenSince ?? now };
}

export function visible(clock: Clock, now: number): Clock | null {
  return alive(clock, now) ? { ...clock, hiddenSince: null } : null;
}

export function prompting(
  clock: Clock,
  pending: boolean,
  isHidden: boolean,
  now: number,
): Clock {
  if (pending) return { ...clock, prompting: true, hiddenSince: null };
  return { ...clock, prompting: false, hiddenSince: isHidden ? now : null };
}

export interface SessionState {
  clock: Clock;
  session: Session;
}

let state: SessionState | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let watching = false;
const listeners = new Set<() => void>();

const isHidden = () =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

function emit() {
  for (const listener of listeners) listener();
}

function schedule(now: number) {
  clearTimeout(timer);
  if (!state) return;
  const { clock } = state;
  const sleepAt =
    clock.hiddenSince !== null && !clock.prompting
      ? clock.hiddenSince + HIDDEN_LIMIT_MS
      : Infinity;
  const at = Math.min(clock.expiresAt, sleepAt);
  timer = setTimeout(endSession, Math.max(0, at - now));
}

function onVisibility() {
  if (!state) return;
  const now = Date.now();
  if (isHidden()) {
    state = { ...state, clock: hidden(state.clock, now) };
  } else {
    const clock = visible(state.clock, now);
    if (!clock) {
      endSession();
      return;
    }
    state = { ...state, clock };
  }
  schedule(now);
  emit();
}

function watch() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("visibilitychange", onVisibility);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sessionSnapshot(): SessionState | null {
  return state;
}

export function startSession(
  session: Session,
  hiddenNow = isHidden(),
  now = Date.now(),
): void {
  watch();
  state = { session, clock: start(session.expiresAt, hiddenNow, now) };
  schedule(now);
  emit();
}

export function endSession(): void {
  clearTimeout(timer);
  state = null;
  emit();
}

export function activeSession(now = Date.now()): Session | null {
  if (!state) return null;
  if (!alive(state.clock, now)) {
    endSession();
    return null;
  }
  return state.session;
}

async function withPrompt<T>(work: () => Promise<T>): Promise<T> {
  if (state) {
    state = {
      ...state,
      clock: prompting(state.clock, true, isHidden(), Date.now()),
    };
    schedule(Date.now());
  }
  try {
    return await work();
  } finally {
    if (state) {
      const now = Date.now();
      state = {
        ...state,
        clock: prompting(state.clock, false, isHidden(), now),
      };
      schedule(now);
      emit();
    }
  }
}

export async function openSession(
  devices: string[],
  prove: Proof = null,
): Promise<Session> {
  const current = activeSession();
  if (
    current &&
    devices.includes(current.grant.credentialId) &&
    (grantVerified(current) ||
      (prove !== "fingerprint" && (!prove || current.grant.proof)))
  ) {
    return current;
  }
  const session = await withPrompt(() =>
    createSession(devices, window.location.hostname, prove),
  );
  startSession(session);
  return session;
}
