"use client";

import { useState } from "react";
import { useCall } from "@/context/CallContext";
import { useIdentity } from "@/context/IdentityContext";

/** Rings a member who isn't in the call (a push, phase 7); resolves when sent, rejects with a readable reason. */
export type NotifyMember = (keyHash: string) => Promise<void>;

/**
 * Dimmed tiles for conversation members who aren't in the call (DESIGN.md §7). It says "not in call", not
 * "offline": the app only knows who joined the room. Notify rings them; nothing else does.
 */
export function AbsentMembers() {
  const { currentCallConversation, peerKeyHashes, notifyMember: onNotify } = useCall();
  const { identity, getDisplayName } = useIdentity();
  const [state, setState] = useState<Record<string, string>>({});
  if (!currentCallConversation || !identity) return null;

  const members =
    currentCallConversation.type === "dm" ? [currentCallConversation.otherKeyHash] : currentCallConversation.memberKeyHashes;
  const here = new Set(peerKeyHashes.values());
  const absent = members.filter((k) => k !== identity.keyHash && !here.has(k));
  if (absent.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2" aria-label="Not in the call">
      {absent.map((k) => (
        <div
          key={k}
          className="flex items-center gap-2 px-3 py-2 rounded border border-dashed border-[var(--border)] bg-[var(--surface)] opacity-60 text-sm"
        >
          <span className="truncate max-w-[10rem]">{getDisplayName(k) || k.slice(0, 8)}</span>
          <span className="text-xs text-[var(--muted)]">not in call</span>
          {onNotify && (
            <button
              type="button"
              disabled={!!state[k] && state[k] !== "Notify"}
              onClick={async () => {
                setState((s) => ({ ...s, [k]: "Sending…" }));
                try {
                  await onNotify(k);
                  setState((s) => ({ ...s, [k]: "Notified" }));
                } catch (e) {
                  setState((s) => ({ ...s, [k]: e instanceof Error ? e.message : "Couldn't notify" }));
                }
                setTimeout(() => setState((s) => ({ ...s, [k]: "Notify" })), 30_000);
              }}
              className="px-2 py-0.5 rounded text-xs bg-[var(--accent)] text-white disabled:opacity-60"
            >
              {state[k] ?? "Notify"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
