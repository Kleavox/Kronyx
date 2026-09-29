import { describe, expect, it } from "vitest";

import {
  activeSession,
  alive,
  endSession,
  hidden,
  HIDDEN_LIMIT_MS,
  prompting,
  remaining,
  SESSION_MS,
  start,
  startSession,
  visible,
} from "./deploy-session";
import type { Session } from "./passkeys";

const T = Date.parse("2026-09-29T10:00:00.000Z");
const MINUTE = 60_000;

describe("deploy session", () => {
  it("lasts 15 minutes while visible", () => {
    const clock = start(T + SESSION_MS, false, T);
    expect(alive(clock, T + 15 * MINUTE - 1)).toBe(true);
    expect(alive(clock, T + 15 * MINUTE)).toBe(false);
    expect(remaining(clock, T + 5 * MINUTE)).toBe(10 * MINUTE);
  });

  it("ends after 2 minutes hidden", () => {
    const clock = hidden(start(T + SESSION_MS, false, T), T + MINUTE);
    expect(alive(clock, T + MINUTE + HIDDEN_LIMIT_MS - 1)).toBe(true);
    expect(alive(clock, T + MINUTE + HIDDEN_LIMIT_MS)).toBe(false);
    expect(visible(clock, T + 4 * MINUTE)).toBeNull();
  });

  it("continues when back within 2 minutes", () => {
    const back = visible(
      hidden(start(T + SESSION_MS, false, T), T + MINUTE),
      T + MINUTE + 100_000,
    );
    expect(back?.hiddenSince).toBeNull();
    expect(alive(back!, T + 14 * MINUTE)).toBe(true);
  });

  it("the hidden timer pauses while a prompt is pending", () => {
    let clock = prompting(start(T + SESSION_MS, false, T), true, false, T);
    clock = hidden(clock, T + MINUTE);
    expect(clock.hiddenSince).toBeNull();
    expect(alive(clock, T + 5 * MINUTE)).toBe(true);
    clock = prompting(clock, false, true, T + 5 * MINUTE);
    expect(clock.hiddenSince).toBe(T + 5 * MINUTE);
    expect(alive(clock, T + 7 * MINUTE)).toBe(false);
  });

  it("starts counting at once when it opens in a hidden tab", () => {
    expect(start(T + SESSION_MS, true, T).hiddenSince).toBe(T);
  });

  it("ends at once on lock", () => {
    const session = { expiresAt: T + SESSION_MS } as Session;
    startSession(session, false, T);
    expect(activeSession(T + MINUTE)).toBe(session);
    endSession();
    expect(activeSession(T + MINUTE)).toBeNull();
  });
});
