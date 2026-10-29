"use client";

import { EVERYONE, splitMentions } from "@/lib/mentions";

export type MentionCandidate = { keyHash: string; label: string };

/** Suggestions while typing "@…" in the composer: the conversation's members (your names for them), plus @everyone in groups. */
export function MentionPicker({
  candidates,
  active,
  onPick,
}: {
  candidates: MentionCandidate[];
  active: number;
  onPick: (c: MentionCandidate) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <ul
      role="listbox"
      aria-label="Mention someone"
      className="mb-1 max-h-48 overflow-auto rounded border border-[var(--border)] bg-[var(--surface)] text-sm shadow-lg"
    >
      {candidates.map((c, i) => (
        <li key={c.keyHash} role="option" aria-selected={i === active}>
          <button
            type="button"
            // Keep focus in the composer: pick on mousedown, before the input would blur.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
            className={`w-full text-left px-3 py-1.5 ${i === active ? "bg-[var(--accent)]/30" : "hover:bg-[var(--border)]"}`}
          >
            @{c.label}
            {c.keyHash === EVERYONE && <span className="ml-2 text-xs text-[var(--muted)]">everyone in this group</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * A text message body with each mention shown as "@name" in the viewer's own names. Mentions of you stand out,
 * except in your own messages.
 */
export function MessageText({
  body,
  myKeyHash,
  nameFor,
  inGroup,
  fromMe,
}: {
  body: string;
  myKeyHash: string;
  nameFor: (keyHash: string) => string;
  inGroup: boolean;
  fromMe: boolean;
}) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {splitMentions(body).map((s, i) => {
        if ("text" in s) return <span key={i}>{s.text}</span>;
        const isEveryone = s.mention === EVERYONE;
        const me = !fromMe && (s.mention === myKeyHash || (isEveryone && inGroup));
        return (
          <span
            key={i}
            className={`px-1 rounded ${me ? "bg-amber-500/30 text-amber-200 font-medium" : "bg-[var(--accent)]/20 text-[var(--accent)]"}`}
          >
            @{isEveryone ? "everyone" : nameFor(s.mention)}
          </span>
        );
      })}
    </span>
  );
}
