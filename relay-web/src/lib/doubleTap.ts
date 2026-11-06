"use client";

import { useEffect, useRef } from "react";

/** Two taps this close in time (ms) and place (px) are a double tap. */
const DOUBLE_MS = 300;
const NEAR_PX = 30;
/** A tap is short and doesn't move: anything longer is a hold, a drag or a scroll. */
const TAP_MS = 300;
const MOVE_PX = 10;

/**
 * Touch double taps, told apart from a pinch: a pinch has two fingers down at once, a double tap is two quick
 * one-finger taps in the same spot. `onSingle` (optional) runs only once it's clear no second tap is coming, so a
 * single tap can still do something else. Mouse clicks are left alone. Spread the handlers on the element.
 */
export function useDoubleTap(onDouble: () => void, onSingle?: () => void) {
  const down = useRef<{ x: number; y: number; at: number } | null>(null);
  const fingers = useRef(0);
  const multi = useRef(false);
  const last = useRef<{ x: number; y: number; at: number } | null>(null);
  const single = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = useRef({ onDouble, onSingle });
  cb.current = { onDouble, onSingle };
  useEffect(() => () => {
    if (single.current) clearTimeout(single.current);
  }, []);

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") return;
      fingers.current++;
      if (fingers.current > 1) multi.current = true;
      if (e.isPrimary) down.current = { x: e.clientX, y: e.clientY, at: Date.now() };
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") return;
      fingers.current = Math.max(0, fingers.current - 1);
      const d = down.current;
      const wasMulti = multi.current;
      if (fingers.current === 0) multi.current = false;
      if (!e.isPrimary || !d || wasMulti) return;
      down.current = null;
      const now = Date.now();
      if (now - d.at > TAP_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > MOVE_PX) return;
      const prev = last.current;
      if (prev && now - prev.at < DOUBLE_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < NEAR_PX) {
        last.current = null;
        if (single.current) clearTimeout(single.current);
        single.current = null;
        cb.current.onDouble();
        return;
      }
      last.current = { x: e.clientX, y: e.clientY, at: now };
      if (cb.current.onSingle) {
        if (single.current) clearTimeout(single.current);
        single.current = setTimeout(() => {
          single.current = null;
          cb.current.onSingle?.();
        }, DOUBLE_MS);
      }
    },
    onPointerCancel: (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") return;
      fingers.current = Math.max(0, fingers.current - 1);
      if (fingers.current === 0) multi.current = false;
      down.current = null;
    },
  };
}
