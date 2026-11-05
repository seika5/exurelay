"use client";

import { useEffect, useRef, useState } from "react";

const WIDTH = 256;

/**
 * A small "?" that shows a tip: on hover with a mouse, on tap on a touch screen (tap again or anywhere else to close).
 * The tip is positioned against the viewport, so a scrolling container can't clip it.
 */
export function InfoTip({ children, label = "More info" }: { children: React.ReactNode; label?: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const pointer = useRef<string>("mouse");

  const show = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - WIDTH / 2), window.innerWidth - WIDTH - 8);
    setPos({ top: r.bottom + 6, left });
  };

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !tip.current?.contains(t)) setPos(null);
    };
    const hide = () => setPos(null);
    document.addEventListener("pointerdown", close);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
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
        className="inline-flex shrink-0 items-center justify-center w-4 h-4 rounded-full border border-[var(--muted)] text-[10px] leading-none text-[var(--muted)] align-middle"
      >
        ?
      </button>
      {pos && (
        <span
          ref={tip}
          role="tooltip"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: WIDTH }}
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
