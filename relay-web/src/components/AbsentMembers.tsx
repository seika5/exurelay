"use client";

import { useRef, useState } from "react";
import { useCall } from "@/context/CallContext";
import { useIdentity } from "@/context/IdentityContext";
import { btnSmall } from "@/components/ui";

/** Rings a member who isn't in the call (a push, phase 7); resolves when sent, rejects with a readable reason. */
export type NotifyMember = (keyHash: string) => Promise<void>;

/**
 * Dimmed tiles for conversation members who aren't in the call (DESIGN.md §7). It says "not in call", not
 * "offline": the app only knows who joined the room. Notify rings them; nothing else does. The result ("Notified",
 * or why not) shows next to the name for a while; the button stays usable.
 */
export function AbsentMembers() {
  const { currentCallConversation, peerKeyHashes, notifyMember: onNotify } = useCall();
  const { identity, getDisplayName } = useIdentity();
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, string>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  if (!currentCallConversation || !identity) return null;

  const members =
    currentCallConversation.type === "dm" ? [currentCallConversation.otherKeyHash] : currentCallConversation.memberKeyHashes;
  const here = new Set(peerKeyHashes.values());
  const absent = members.filter((k) => k !== identity.keyHash && !here.has(k));
  if (absent.length === 0) return null;

  const notify = async (k: string) => {
    if (!onNotify) return;
    setSending((s) => new Set(s).add(k));
    let result: string;
    try {
      await onNotify(k);
      result = "Notified";
    } catch (e) {
      result = e instanceof Error ? e.message : "Couldn't notify";
    }
    setSending((s) => {
      const next = new Set(s);
      next.delete(k);
      return next;
    });
    setStatus((s) => ({ ...s, [k]: result }));
    clearTimeout(timers.current[k]);
    timers.current[k] = setTimeout(() => setStatus((s) => {
      const next = { ...s };
      delete next[k];
      return next;
    }), 30_000);
  };

  return (
    <div className="flex flex-wrap gap-2 mt-2" aria-label="Not in the call">
      {absent.map((k) => (
        <div
          key={k}
          className="flex items-center gap-2 px-3 py-1.5 rounded border border-dashed border-[var(--border)] bg-[var(--surface)] text-sm max-w-full"
        >
          <span className="flex flex-col min-w-0">
            <span className="truncate max-w-[10rem] opacity-70">{getDisplayName(k) || k.slice(0, 8)}</span>
            <span className="text-xs text-[var(--muted)]" aria-live="polite">
              {status[k] ?? "Not in call"}
            </span>
          </span>
          {onNotify && (
            <button type="button" disabled={sending.has(k)} onClick={() => notify(k)} className={btnSmall}>
              {sending.has(k) ? "Sending…" : "Notify"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
