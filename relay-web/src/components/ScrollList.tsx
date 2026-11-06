"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A bordered list that scrolls inside its box (Settings: chats to clear, members, devices). When there's more than
 * fits, a scrollbar of our own shows on the right all the time, so it's clear the list scrolls; the browser's own
 * one is hidden (an iPhone only shows it while scrolling). The bar can be dragged with a mouse. Rows go in <li>s.
 */
export function ScrollList({ children }: { children: React.ReactNode }) {
  const list = useRef<HTMLUListElement>(null);
  const [bar, setBar] = useState<{ top: number; height: number } | null>(null);
  const drag = useRef<{ y: number; top: number } | null>(null);

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight + 1) return setBar(null);
      const height = Math.max(24, (clientHeight * clientHeight) / scrollHeight);
      setBar({ top: (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height), height });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    const mo = new MutationObserver(() => {
      for (const c of el.children) ro.observe(c);
      update();
    });
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!list.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, top: list.current.scrollTop };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = list.current;
    if (!drag.current || !el || !bar) return;
    const track = el.clientHeight - bar.height;
    if (track > 0) el.scrollTop = drag.current.top + ((e.clientY - drag.current.y) / track) * (el.scrollHeight - el.clientHeight);
  };
  const stop = () => {
    drag.current = null;
  };

  return (
    <div className="relative rounded border border-[var(--border)]">
      <ul
        ref={list}
        className="no-scrollbar flex flex-col max-h-60 overflow-auto divide-y divide-[var(--border)]"
        style={bar ? { paddingRight: 8 } : undefined}
      >
        {children}
      </ul>
      {bar && (
        <div
          aria-hidden
          className="absolute right-0.5 w-1.5 rounded-full bg-[var(--muted)] opacity-70 hover:opacity-100 cursor-grab touch-none"
          style={{ top: bar.top + 2, height: bar.height - 4 }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stop}
          onPointerCancel={stop}
        />
      )}
    </div>
  );
}
