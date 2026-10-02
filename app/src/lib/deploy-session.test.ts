import { describe, expect, it } from "vitest";

import {
  activeSession,
  alive,
  endSession,
  hidden,
  prompting,
  SESSION_MS,
  start,
  startSession,
  visible,
} from "./deploy-session";
import type { Session } from "./passkeys";

const T = Date.parse("2026-09-29T10:00:00.000Z");
const MINUTE = 60_000;

describe("deploy session", () => {
  it("lasts 5 minutes while visible", () => {
    const clock = start(T + SESSION_MS, false, T);
    expect(alive(clock, T + 5 * MINUTE - 1)).toBe(true);
    expect(alive(clock, T + 5 * MINUTE)).toBe(false);
  });

  it("ends at once when the page is hidden, as on a locked screen", () => {
    const clock = hidden(start(T + SESSION_MS, false, T), T + MINUTE);
    expect(alive(clock, T + MINUTE)).toBe(false);
    expect(visible(clock, T + MINUTE + 1)).toBeNull();
  });

  it("a pending passkey prompt keeps it while the page is hidden", () => {
    let clock = prompting(start(T + SESSION_MS, false, T), true, false, T);
    clock = hidden(clock, T + MINUTE);
    expect(alive(clock, T + 2 * MINUTE)).toBe(true);
    clock = prompting(clock, false, false, T + 2 * MINUTE);
    expect(alive(clock, T + 3 * MINUTE)).toBe(true);
    clock = prompting(clock, false, true, T + 3 * MINUTE);
    expect(alive(clock, T + 3 * MINUTE)).toBe(false);
  });

  it("opening in a hidden tab ends it at once", () => {
    expect(alive(start(T + SESSION_MS, true, T), T)).toBe(false);
  });

  it("a laptop that slept past the end needs a new fingerprint", () => {
    const session = { expiresAt: T + SESSION_MS } as Session;
    startSession(session, false, T);
    expect(activeSession(T + 4 * MINUTE)).toBe(session);
    expect(activeSession(T + 6 * MINUTE)).toBeNull();
  });

  it("ends when asked", () => {
    const session = { expiresAt: T + SESSION_MS } as Session;
    startSession(session, false, T);
    expect(activeSession(T + MINUTE)).toBe(session);
    endSession();
    expect(activeSession(T + MINUTE)).toBeNull();
  });
});
