/**
 * Muted chats, on this device only (the server never learns which). A muted chat shows no white unread dot; mentions,
 * calls and rings still show yellow, and their pushes still come.
 *
 * Stored per server (serverScopedKey) as { [conversationId]: until }, until a time in ms, or FOREVER.
 */

import { useCallback, useEffect, useState } from "react";
import { serverScopedKey } from "./server";

/** Muted until turned off. JSON has no Infinity. */
export const FOREVER = -1;

export type Mutes = Record<string, number>;

export const MUTE_OPTIONS: { label: string; ms: number | null }[] = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "8 hours", ms: 8 * 60 * 60 * 1000 },
  { label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "Until I unmute", ms: null },
];

/** When a mute chosen now ends: a duration, or null for until turned off. */
export function muteUntil(ms: number | null, now: number): number {
  return ms === null ? FOREVER : now + ms;
}

export function isMuted(until: number | undefined, now: number): boolean {
  return until === FOREVER || (until !== undefined && until > now);
}

/** Only the mutes still in force. */
export function activeMutes(mutes: Mutes, now: number): Mutes {
  return Object.fromEntries(Object.entries(mutes).filter(([, u]) => typeof u === "number" && isMuted(u, now)));
}

/** The next time a mute runs out, if any (so the list can update then). */
export function nextExpiry(mutes: Mutes, now: number): number | null {
  const ends = Object.values(mutes).filter((u) => u !== FOREVER && u > now);
  return ends.length ? Math.min(...ends) : null;
}

/** "Muted", "Muted until 3:40 PM", or with the day when it's not today. */
export function muteLabel(until: number, now: number): string {
  if (until === FOREVER) return "Muted";
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return `Muted until ${time}`;
  return `Muted until ${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

const KEY = "relay.mutes";

function load(): Mutes {
  try {
    const raw = JSON.parse(localStorage.getItem(serverScopedKey(KEY)) || "{}");
    return raw && typeof raw === "object" ? activeMutes(raw as Mutes, Date.now()) : {};
  } catch {
    return {};
  }
}

function save(m: Mutes) {
  try {
    localStorage.setItem(serverScopedKey(KEY), JSON.stringify(m));
  } catch {
    // Storage unavailable: the mute lasts for this session only.
  }
}

/** This server's muted chats, kept current as mutes run out. */
export function useMutes() {
  const [mutes, setMutes] = useState<Mutes>({});
  useEffect(() => setMutes(load()), []);

  // Re-render when the next mute ends (timers top out at about 24 days; it checks again then).
  useEffect(() => {
    const next = nextExpiry(mutes, Date.now());
    if (next === null) return;
    const t = setTimeout(() => setMutes((m) => activeMutes(m, Date.now())), Math.min(next - Date.now() + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [mutes]);

  const setMute = useCallback((id: string, until: number | null) => {
    setMutes((m) => {
      const next = { ...activeMutes(m, Date.now()) };
      if (until === null) delete next[id];
      else next[id] = until;
      save(next);
      return next;
    });
  }, []);

  const mutedUntil = useCallback((id: string) => (isMuted(mutes[id], Date.now()) ? mutes[id] : undefined), [mutes]);

  return { mutedUntil, setMute };
}
