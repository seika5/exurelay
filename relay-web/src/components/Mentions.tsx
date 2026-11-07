"use client";

import type { ReactNode } from "react";
import { parseFormatting, type FmtNode } from "@/lib/format";
import { EVERYONE } from "@/lib/mentions";

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
 * A text message body, formatted (format.ts), with each mention shown as "@name" in the viewer's own names.
 * Mentions of you stand out, except in your own messages.
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
  const render = (nodes: FmtNode[]): ReactNode[] =>
    nodes.map((n, i) => {
      switch (n.type) {
        case "text":
          return <span key={i}>{n.text}</span>;
        case "bold":
          return (
            <strong key={i} className="font-semibold">
              {render(n.children)}
            </strong>
          );
        case "italic":
          return <em key={i}>{render(n.children)}</em>;
        case "code":
          return (
            <code key={i} className="rounded bg-white/10 px-1 py-px font-mono text-[0.85em]">
              {n.text}
            </code>
          );
        case "codeBlock":
          return (
            <pre
              key={i}
              className="my-1 max-w-full overflow-x-auto whitespace-pre rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs"
            >
              <code>{n.text}</code>
            </pre>
          );
        case "link":
          return (
            <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--accent)] underline underline-offset-2">
              {n.text}
            </a>
          );
        case "mention": {
          const isEveryone = n.id === EVERYONE;
          const me = !fromMe && (n.id === myKeyHash || (isEveryone && inGroup));
          return (
            <span key={i} className={me ? "text-amber-300 font-medium" : "text-[var(--accent)] font-medium"}>
              @{isEveryone ? "everyone" : nameFor(n.id)}
            </span>
          );
        }
      }
    });
  return <span className="selectable whitespace-pre-wrap break-words">{render(parseFormatting(body))}</span>;
}
