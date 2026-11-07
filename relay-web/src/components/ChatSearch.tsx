"use client";

import { useEffect, useMemo, useState } from "react";
import { IconButton } from "@/components/icons";
import { field } from "@/components/ui";
import { findMatches, matchRanges } from "@/lib/chatView";

/** The CSS highlight (globals.css ::highlight) for the matched text in the current result. */
const HIGHLIGHT = "relay-search";

function clearHighlight() {
  if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete(HIGHLIGHT);
}

/**
 * Bring a message into view, flash it, and mark the matched text in it. The message rows carry data-mid; the
 * text is marked with the CSS Custom Highlight API (no change to the message's DOM), where the browser has it.
 */
function showMatch(list: HTMLElement, id: string, query: string) {
  const row = list.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#a78bfa";
  row.animate(
    { backgroundColor: [`color-mix(in srgb, ${accent} 30%, transparent)`, getComputedStyle(row).backgroundColor] },
    { duration: 1600, easing: "ease-out" }
  );
  clearHighlight();
  if (!("highlights" in CSS) || typeof Highlight === "undefined") return;
  // Just the message text (the sender's name and the time above it aren't searched).
  const root = row.querySelector(".selectable") ?? row;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const text = nodes.map((n) => n.data).join("");
  // Offsets in the joined text, mapped back to a text node and an offset in it (a match can span the "@name" spans).
  const at = (pos: number, end: boolean): [Text, number] | null => {
    let start = 0;
    for (const n of nodes) {
      if (pos < start + n.length || (end && pos === start + n.length)) return [n, pos - start];
      start += n.length;
    }
    return null;
  };
  const ranges = matchRanges(text, query).flatMap(([s, e]) => {
    const a = at(s, false);
    const b = at(e, true);
    if (!a || !b) return [];
    const r = document.createRange();
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1]);
    return [r];
  });
  if (ranges.length) CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
}

/**
 * Search the open chat, on this device (the server can't read messages). Results go newest first: Enter or the up
 * arrow goes to an older one, Shift+Enter or the down arrow to a newer one. Escape closes it.
 */
export function ChatSearch({
  items,
  listRef,
  onClose,
}: {
  /** The chat's searchable messages, oldest first, as read (mentions as @names). */
  items: { id: string; text: string }[];
  listRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const matches = useMemo(() => findMatches(items, query), [items, query]);
  const current = matches.length ? matches[Math.min(index, matches.length - 1)] : null;

  useEffect(() => {
    if (current && listRef.current) showMatch(listRef.current, current, query);
    else clearHighlight();
  }, [current, query, listRef]);
  useEffect(() => clearHighlight, []);

  const step = (by: number) => matches.length && setIndex((i) => (Math.min(i, matches.length - 1) + by + matches.length) % matches.length);

  return (
    <div className="px-3 py-1.5 border-b border-[var(--border)] flex items-center gap-1.5" role="search">
      <input
        type="text"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            step(e.key === "ArrowUp" ? 1 : -1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        enterKeyHint="search"
        placeholder="Search this chat"
        aria-label="Search this chat"
        className={`${field} flex-1 min-w-0 py-1.5`}
      />
      {query.trim() && (
        <span className="shrink-0 text-xs text-[var(--muted)] tabular-nums" role="status" aria-label="Search results">
          {matches.length ? `${Math.min(index, matches.length - 1) + 1} of ${matches.length}` : "None"}
        </span>
      )}
      <IconButton icon="chatUp" label="Older match" disabled={matches.length < 2} onClick={() => step(1)} />
      <IconButton icon="chatDown" label="Newer match" disabled={matches.length < 2} onClick={() => step(-1)} />
      <IconButton icon="close" label="Close search" onClick={onClose} />
    </div>
  );
}
