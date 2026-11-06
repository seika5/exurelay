"use client";

import { useEffect, useRef, useState } from "react";

const WIDTH = 256;

/**
 * A small "?" that shows a tip: on hover with a mouse, on tap on a touch screen (tap again or anywhere else to close).
 * The tip is positioned against the viewport, so a scrolling container can't clip it.
 */
export function InfoTip({ children, label = "More info" }: { children: React.ReactNode; label?: string }) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const pointer = useRef<string>("mouse");

  const show = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - WIDTH / 2), window.innerWidth - WIDTH - 8);
    // Below the "?", or above it when there's no room below (a tip low on the screen).
    const below = r.bottom + 6;
    setPos(below + 120 > window.innerHeight ? { bottom: window.innerHeight - r.top + 6, left } : { top: below, left });
  };

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !tip.current?.contains(t)) setPos(null);
    };
    const hide = () => setPos(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPos(null);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", close);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [pos]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={!!pos}
        onPointerDown={(e) => (pointer.current = e.pointerType)}
        onPointerEnter={(e) => e.pointerType === "mouse" && show()}
        onPointerLeave={(e) => e.pointerType === "mouse" && setPos(null)}
        onClick={() => (pointer.current === "mouse" ? show() : pos ? setPos(null) : show())}
        className="relative inline-flex shrink-0 items-center justify-center w-4 h-4 rounded-full border border-[var(--muted)] text-[10px] leading-none text-[var(--muted)] align-middle before:absolute before:-inset-3 before:content-['']"
      >
        ?
      </button>
      {pos && (
        <span
          ref={tip}
          role="tooltip"
          style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, width: WIDTH }}
          className="z-50 p-2 rounded border border-[var(--border)] bg-[var(--surface)] text-xs text-[var(--text)] shadow-lg font-normal"
        >
          {children}
        </span>
      )}
    </>
  );
}

/** A settings section heading with an optional tip next to it. */
export function SectionTitle({ children, tip }: { children: React.ReactNode; tip?: React.ReactNode }) {
  return (
    <h3 className="text-sm font-medium flex items-center gap-1.5">
      {children}
      {tip && <InfoTip>{tip}</InfoTip>}
    </h3>
  );
}

/** A section that opens and closes (Settings → Admin): a heading row with an arrow, the content below. */
export function Collapsible({
  title,
  tip,
  defaultOpen = false,
  children,
}: {
  title: React.ReactNode;
  tip?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group flex flex-col">
      <summary className="flex items-center gap-1.5 py-1 touch:py-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden text-sm font-medium">
        <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden>
          <path d="M9 5l7 7-7 7" />
        </svg>
        {title}
        {tip && <InfoTip>{tip}</InfoTip>}
      </summary>
      <div className="flex flex-col gap-2 pt-2">{children}</div>
    </details>
  );
}
