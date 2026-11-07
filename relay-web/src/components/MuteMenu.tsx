"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";
import { InfoTip } from "@/components/InfoTip";
import { MUTE_OPTIONS, muteLabel, muteUntil } from "@/lib/mute";

const item = "w-full flex items-center gap-2 text-left px-3 py-2 touch:py-2.5 rounded text-sm hover:bg-[var(--border)] active:bg-[var(--border)]";

/**
 * The chat header's menu under its button: mute for a while, or unmute. On phones it's the "more" menu, with Search
 * first (the header has no room for both icons there). Escape or a tap elsewhere closes it. Its button has
 * data-menu-anchor, so a tap on it toggles instead of closing and reopening.
 */
export function MuteMenu({
  anchor,
  until,
  onMute,
  onSearch,
  onClose,
}: {
  anchor: DOMRect;
  /** When the chat's mute ends, if it's muted (FOREVER for until turned off). */
  until: number | undefined;
  /** A new end time, or null to unmute. */
  onMute: (until: number | null) => void;
  onSearch?: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.bottom + 4, left: anchor.right - 224 });
  useLayoutEffect(() => {
    const w = box.current?.offsetWidth ?? 224;
    setPos({ top: anchor.bottom + 4, left: Math.max(8, Math.min(anchor.right - w, window.innerWidth - w - 8)) });
  }, [anchor]);
  useEffect(() => {
    // Not on the button that opened it: that one toggles it.
    const away = (e: PointerEvent) =>
      !box.current?.contains(e.target as Node) && !(e.target as Element).closest?.("[data-menu-anchor]") && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const pick = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label="Chat options"
      className="fixed z-50 w-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl p-1 flex flex-col"
      style={pos}
    >
      {onSearch && (
        <>
          <button type="button" role="menuitem" className={item} onClick={pick(onSearch)}>
            <Icon name="chatSearch" />
            Search
          </button>
          <div className="my-1 border-t border-[var(--border)]" />
        </>
      )}
      {until !== undefined ? (
        <>
          <p className="px-3 py-1.5 text-xs text-[var(--muted)]">{muteLabel(until, Date.now())}</p>
          <button type="button" role="menuitem" className={item} onClick={pick(() => onMute(null))}>
            <Icon name="callBell" />
            Unmute
          </button>
        </>
      ) : (
        <p className="px-3 py-1.5 text-xs text-[var(--muted)] flex items-center gap-1.5">
          <Icon name="chatMuted" size={14} />
          Mute
          <InfoTip>No unread dot. Mentions, calls and rings still show, and still notify.</InfoTip>
        </p>
      )}
      {MUTE_OPTIONS.map((o) => (
        <button
          key={o.label}
          type="button"
          role="menuitem"
          aria-label={o.ms === null ? "Mute until I unmute" : `Mute for ${o.label}`}
          className={`${item} pl-9`}
          onClick={pick(() => onMute(muteUntil(o.ms, Date.now())))}
        >
          {o.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
