import { describe, it, expect } from "vitest";
import { FOREVER, activeMutes, isMuted, muteLabel, muteUntil, nextExpiry, MUTE_OPTIONS } from "../mute";

const NOW = new Date(2026, 10, 6, 12, 0).getTime();
const HOUR = 60 * 60 * 1000;

describe("mute", () => {
  it("ends after the chosen time, or never", () => {
    expect(MUTE_OPTIONS.map((o) => o.ms)).toEqual([HOUR, 8 * HOUR, 7 * 24 * HOUR, null]);
    expect(muteUntil(HOUR, NOW)).toBe(NOW + HOUR);
    expect(muteUntil(null, NOW)).toBe(FOREVER);
  });

  it("is muted until it runs out", () => {
    expect(isMuted(NOW + 1, NOW)).toBe(true);
    expect(isMuted(NOW, NOW)).toBe(false);
    expect(isMuted(FOREVER, NOW + 1e12)).toBe(true);
    expect(isMuted(undefined, NOW)).toBe(false);
  });

  it("drops mutes that ran out and finds the next to end", () => {
    const m = { a: NOW - 1, b: NOW + 2 * HOUR, c: FOREVER, d: NOW + HOUR };
    expect(activeMutes(m, NOW)).toEqual({ b: NOW + 2 * HOUR, c: FOREVER, d: NOW + HOUR });
    expect(nextExpiry(m, NOW)).toBe(NOW + HOUR);
    expect(nextExpiry({ c: FOREVER }, NOW)).toBeNull();
  });

  it("says when it ends, with the day if not today", () => {
    expect(muteLabel(FOREVER, NOW)).toBe("Muted");
    const today = muteLabel(NOW + HOUR, NOW);
    expect(today.startsWith("Muted until ")).toBe(true);
    // Another day adds the date (locale-dependent, so only its presence is checked).
    expect(muteLabel(NOW + 3 * 24 * HOUR, NOW).length).toBeGreaterThan(today.length);
  });
});
