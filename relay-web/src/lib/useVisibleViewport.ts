"use client";

import { useEffect, useState } from "react";

/** A text field that brings up the on-screen keyboard. */
function editable(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !["checkbox", "radio", "range", "button", "submit", "file", "color"].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

type Visible = { top: number; height: number | null; keyboard: boolean };

/**
 * The part of the screen not covered by the on-screen keyboard, for a layout pinned to it.
 *
 * iOS doesn't resize the page when the keyboard opens: it scrolls the page to keep the focused field visible, which
 * carried the header off the top, and correcting that afterwards made the screen overshoot and flick back. So while
 * the chat screen shows, the page itself is locked (PageLock below, html.page-locked in globals.css) and can't scroll; iOS can still pan the
 * visible area, and the layout follows it on every animation frame while the keyboard moves, instead of once at the
 * end.
 *
 * `keyboard` is true while the keyboard is up. In an installed iPhone app window.innerHeight can shrink with the
 * keyboard, so this compares against the tallest height seen in this orientation, and on touch screens also counts a
 * focused text field.
 */
export function useVisibleViewport(): Visible {
  const [state, setState] = useState<Visible>({ top: 0, height: null, keyboard: false });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const touch = window.matchMedia("(pointer: coarse)").matches;
    let tallest = 0;
    let width = 0;
    let last = "";
    const read = () => {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        tallest = 0;
      }
      const focused = touch && editable(document.activeElement);
      if (!focused) tallest = Math.max(tallest, vv.height, window.innerHeight);
      const next = { top: vv.offsetTop, height: vv.height, keyboard: focused || vv.height < tallest - 100 };
      const key = `${next.top}|${next.height}|${next.keyboard}`;
      if (key !== last) {
        last = key;
        setState(next);
      }
    };
    // While the keyboard slides in or out, follow it every frame for a moment (its events alone come too late).
    let frame = 0;
    let until = 0;
    const tick = () => {
      read();
      frame = performance.now() < until ? requestAnimationFrame(tick) : 0;
    };
    const follow = () => {
      read();
      until = performance.now() + 800;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    read();
    vv.addEventListener("resize", follow);
    vv.addEventListener("scroll", follow);
    document.addEventListener("focusin", follow);
    document.addEventListener("focusout", follow);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", follow);
      vv.removeEventListener("scroll", follow);
      document.removeEventListener("focusin", follow);
      document.removeEventListener("focusout", follow);
    };
  }, []);
  return state;
}

/** Locks the page (no scrolling of the page itself) while mounted: render it inside the chat screen only. */
export function PageLock() {
  useEffect(() => {
    document.documentElement.classList.add("page-locked");
    return () => document.documentElement.classList.remove("page-locked");
  }, []);
  return null;
}
