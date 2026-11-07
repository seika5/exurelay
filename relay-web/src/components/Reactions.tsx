"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_QUICK_EMOJI, EMOJI_GROUPS, getQuickEmoji, setQuickEmoji } from "@/lib/emoji";
import { SectionTitle } from "@/components/InfoTip";
import { useVisibleViewport } from "@/lib/useVisibleViewport";
import type { Reaction } from "@/lib/reactions";
import { Icon, type IconName } from "@/components/icons";
import { btn, btnDanger, field } from "@/components/ui";
import { EMOJI_NAMES } from "@/lib/emojiNames";

/**
 * Every emoji, by group, as buttons, with a search box, and your quick reactions on top unless `showQuick` is off
 * (where they're already shown just above). `onPick` gets the click too (shift-click keeps a popover open).
 */
export function EmojiPicker({
  onPick,
  className = "",
  showQuick = true,
  autoFocus = false,
}: {
  onPick: (emoji: string, e: React.MouseEvent) => void;
  className?: string;
  showQuick?: boolean;
  autoFocus?: boolean;
}) {
  const [quick] = useState(getQuickEmoji);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const groups = q
    ? [{ name: "Results", emoji: EMOJI_GROUPS.flatMap((g) => g.emoji).filter((e, i, all) => all.indexOf(e) === i && (EMOJI_NAMES[e] ?? "").includes(q)) }]
    : showQuick
      ? [{ name: "Quick reactions", emoji: quick }, ...EMOJI_GROUPS]
      : EMOJI_GROUPS;
  return (
    <div className={`overflow-auto ${className}`}>
      <div className="sticky top-0 z-20 bg-[var(--surface)] pb-1">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search emoji"
          autoFocus={autoFocus}
          className={`${field} w-full`}
        />
      </div>
      {q && groups[0].emoji.length === 0 && <p className="px-1 py-3 text-sm text-[var(--muted)]">No emoji found.</p>}
      {groups.map((g) => (
        <section key={g.name} aria-label={g.name}>
          {/* Your quick reactions and search results sit on top without a heading. */}
          {g.name !== "Quick reactions" && g.name !== "Results" && <h4 className="sticky top-11 z-10 bg-[var(--surface)] px-1 py-1 text-xs text-[var(--muted)]">{g.name}</h4>}
          <div className="grid grid-cols-8 gap-0.5">
            {g.emoji.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={e}
                onClick={(ev) => onPick(e, ev)}
                className="h-9 touch:h-11 rounded text-xl leading-none hover:bg-white/10"
              >
                {e}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** The reactions under a message: each emoji with its count, yours highlighted; tap one to add or take back yours. */
export function ReactionChips({
  reactions,
  me,
  nameFor,
  onToggle,
}: {
  reactions: Reaction[];
  me: string;
  nameFor: (k: string) => string;
  onToggle: (emoji: string) => void;
}) {
  if (!reactions.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {reactions.map((r) => {
        const mine = r.by.includes(me);
        const who = r.by.map((k) => (k === me ? "You" : nameFor(k))).join(", ");
        return (
          <button
            key={r.emoji}
            type="button"
            onClick={() => onToggle(r.emoji)}
            aria-pressed={mine}
            aria-label={`${r.emoji} ${r.by.length}: ${who}`}
            title={who}
            className={`inline-flex items-center gap-1 h-7 touch:h-8 px-2 rounded-full border text-sm ${
              mine ? "border-[var(--accent)] bg-[var(--accent)]/20" : "border-[var(--border)] bg-[var(--surface)] hover:bg-white/5"
            }`}
          >
            <span className="text-base leading-none">{r.emoji}</span>
            <span className="tabular-nums text-xs">{r.by.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Desktop: the picker next to a message's react button. Click an emoji to react and close; shift-click to react and
 * keep it open. Escape or a click elsewhere closes it.
 */
export function ReactionPopover({ anchor, onPick, onClose }: { anchor: DOMRect; onPick: (emoji: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: anchor.bottom + 4, left: anchor.right - 320 });
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 360;
    const top = anchor.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, anchor.top - 4 - h) : anchor.bottom + 4;
    setPos({ top, left: Math.max(8, Math.min(anchor.right - 320, window.innerWidth - 328)) });
  }, [anchor]);
  useEffect(() => {
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label="React"
      className="fixed z-50 w-80 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl p-2 flex flex-col gap-2"
      style={pos}
    >
      <EmojiPicker className="max-h-72" onPick={(e, ev) => (onPick(e), !ev.shiftKey && onClose())} />
      <p className="text-[11px] text-[var(--muted)]">Shift-click to add more than one</p>
    </div>,
    document.body
  );
}

/** An action the sheet offers below Copy (Reply, Edit, Delete). The sheet closes first. */
export type SheetAction = { label: string; icon: IconName; onClick: () => void; danger?: boolean };

/**
 * Phone: what press and hold on a message brings up from the bottom. Five quick reactions, a button for every emoji,
 * Copy (for text), and any `actions`.
 */
export function MessageSheet({
  onReact,
  copyText,
  actions = [],
  onClose,
}: {
  onReact: (emoji: string) => void;
  /** The message's text, if it has any to copy. */
  copyText: string | null;
  actions?: SheetAction[];
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
  const [quick] = useState(getQuickEmoji);
  const visible = useVisibleViewport();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  const pick = (e: string) => {
    onReact(e);
    onClose();
  };
  return createPortal(
    // Closes on a new touch outside it, not a click: lifting the finger that opened it sends a click here.
    // Pinned to the part of the screen above the keyboard (the search box can bring it up).
    <div
      className="fixed inset-x-0 top-0 z-50 flex flex-col justify-end"
      style={{ top: visible.top, height: visible.height ?? "100%" }}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Message"
        className="rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface)] px-3 pt-3 flex flex-col gap-3 shadow-[0_-8px_24px_rgba(0,0,0,0.4)]"
        // At least a third of the screen tall, however little is in it.
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)", minHeight: visible.height ? visible.height / 3 : "33vh" }}
      >
        <div className="flex items-center justify-between gap-1">
          {quick.map((e) => (
            <button key={e} type="button" aria-label={e} onClick={() => pick(e)} className="h-12 w-12 rounded-full bg-[var(--bg)] text-2xl">
              {e}
            </button>
          ))}
          <button
            type="button"
            aria-label="All emoji"
            aria-expanded={all}
            onClick={() => setAll(!all)}
            className="h-12 w-12 rounded-full bg-[var(--bg)] flex items-center justify-center text-[var(--text)]"
          >
            <Icon name="chatReact" size={22} />
          </button>
        </div>
        {all && <EmojiPicker className="max-h-[45vh]" showQuick={false} onPick={(e) => pick(e)} />}
        {copyText !== null && !all && (
          <button
            type="button"
            className={`${btn} !justify-start gap-3 h-12 px-4`}
            onClick={async () => {
              await navigator.clipboard.writeText(copyText).catch(() => {});
              onClose();
            }}
          >
            <Icon name="chatCopy" size={18} />
            Copy
          </button>
        )}
        {!all &&
          actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`${a.danger ? btnDanger : btn} !justify-start gap-3 h-12 px-4`}
              onClick={() => {
                onClose();
                a.onClick();
              }}
            >
              <Icon name={a.icon} size={18} />
              {a.label}
            </button>
          ))}
      </div>
    </div>,
    document.body
  );
}

/** Settings → General: the 5 quick reactions. Tap one, then pick what replaces it. Kept on this device. */
export function QuickReactionsSection() {
  const [quick, setQuick] = useState<string[]>(DEFAULT_QUICK_EMOJI);
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => setQuick(getQuickEmoji()), []);
  const choose = (emoji: string) => {
    if (editing === null) return;
    const next = quick.map((e, i) => (i === editing ? emoji : e));
    setQuick(next);
    setQuickEmoji(next);
    setEditing(null);
  };
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle tip="The five on top when you react. A double tap on a message reacts with the first (leftmost) one. Tap one to change it.">
        Quick reactions
      </SectionTitle>
      <div className="flex gap-2">
        {quick.map((e, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Quick reaction ${i + 1}: ${e}`}
            aria-pressed={editing === i}
            onClick={() => setEditing(editing === i ? null : i)}
            className={`h-11 w-11 rounded-lg border text-2xl ${editing === i ? "border-[var(--accent)] bg-[var(--accent)]/20" : "border-[var(--border)]"}`}
          >
            {e}
          </button>
        ))}
      </div>
      {editing !== null && <EmojiPicker className="max-h-64 rounded border border-[var(--border)] p-1" showQuick={false} onPick={(e) => choose(e)} />}
    </section>
  );
}
