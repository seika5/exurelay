"use client";

import { useEffect, useState } from "react";
import { useCall } from "@/context/CallContext";
import { useIdentity } from "@/context/IdentityContext";
import { Icon } from "@/components/icons";

/** Rings a member who isn't in the call (a push, phase 7); resolves when sent, rejects with a readable reason. */
export type NotifyMember = (keyHash: string) => Promise<void>;

/** The server lets each person be rung once every 30 seconds (relay-server lib/pushLimits.js). */
const RING_COOLDOWN_MS = 30_000;

/** Conversation members who aren't in the call (DESIGN.md §7): the app only knows who joined the room. */
export function useAbsentMembers(): string[] {
  const { currentCallConversation, peerKeyHashes } = useCall();
  const { identity } = useIdentity();
  if (!currentCallConversation || !identity) return [];
  const members =
    currentCallConversation.type === "dm" ? [currentCallConversation.otherKeyHash] : currentCallConversation.memberKeyHashes;
  const here = new Set(peerKeyHashes.values());
  return members.filter((k) => k !== identity.keyHash && !here.has(k));
}

/**
 * A dimmed tile, the size of the call's own tiles, for a member who isn't in the call. Its bell rings them; then it
 * shows the seconds until they can be rung again, greyed out. "Not in call", not "offline": that's all the app knows.
 */
export function AbsentTile({ keyHash }: { keyHash: string }) {
  const { notifyMember } = useCall();
  const { getDisplayName } = useIdentity();
  const [sending, setSending] = useState(false);
  const [until, setUntil] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const left = Math.ceil((until - now) / 1000);

  useEffect(() => {
    if (until <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [until]);

  const name = getDisplayName(keyHash) || keyHash.slice(0, 8);
  const ring = async () => {
    if (!notifyMember) return;
    setSending(true);
    setError(null);
    try {
      await notifyMember(keyHash);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't notify");
    } finally {
      setSending(false);
      setNow(Date.now());
      setUntil(Date.now() + RING_COOLDOWN_MS);
    }
  };

  return (
    <div className="relative w-full h-full rounded border border-dashed border-[var(--border)] bg-[var(--surface)] flex items-center justify-center">
      <span className="text-4xl font-bold text-[var(--muted)] opacity-60">{name[0]?.toUpperCase() ?? "?"}</span>
      <span className="absolute bottom-0 left-0 right-0 flex flex-col px-1.5 py-0.5 text-xs bg-black/40">
        <span className="truncate opacity-80">{name}</span>
        <span className="truncate text-[var(--muted)]" aria-live="polite">
          {error ?? "Not in call"}
        </span>
      </span>
      {notifyMember && (
        <button
          type="button"
          disabled={sending || left > 0}
          onClick={ring}
          aria-label={left > 0 ? `Notify ${name} again in ${left} seconds` : `Notify ${name}`}
          title={left > 0 ? `Again in ${left}s` : `Notify ${name}`}
          className="absolute top-1 right-1 inline-flex h-8 min-w-8 px-1 touch:h-10 touch:min-w-10 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--text)] text-sm tabular-nums disabled:opacity-50"
        >
          {left > 0 ? left : <Icon name="callBell" />}
        </button>
      )}
    </div>
  );
}
