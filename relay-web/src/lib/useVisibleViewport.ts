"use client";

import { useEffect, useState } from "react";

/** A text field that brings up the on-screen keyboard. */
function editable(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !["checkbox", "radio", "range", "button", "submit", "file", "color"].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * The part of the screen not covered by the on-screen keyboard. iOS doesn't resize the page when the keyboard opens:
 * it scrolls the whole page to keep the focused field visible, which pushes a full-height layout's header off the top
 * and leaves a gap that depends on how far it scrolled. A layout pinned to this area (top and height) stays put
 * instead.
 *
 * `keyboard` is true while the keyboard is up. In an installed iPhone app window.innerHeight can shrink with the
 * keyboard, so comparing against it misses the keyboard; this compares against the tallest height seen in this
 * orientation, and on touch screens also counts a focused text field.
 */
export function useVisibleViewport(): { top: number; height: number | null; keyboard: boolean } {
  const [state, setState] = useState<{ top: number; height: number | null; keyboard: boolean }>({ top: 0, height: null, keyboard: false });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const touch = window.matchMedia("(pointer: coarse)").matches;
    let tallest = 0;
    let width = 0;
    const update = () => {
      // The page itself must not scroll: everything scrollable lives inside the layout.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        tallest = 0;
      }
      const focused = touch && editable(document.activeElement);
      if (!focused) tallest = Math.max(tallest, vv.height, window.innerHeight);
      setState({ top: vv.offsetTop, height: vv.height, keyboard: focused || vv.height < tallest - 100 });
    };
    // Focus changes before the keyboard's own resize events, and on some iOS versions without them.
    const soon = () => setTimeout(update, 0);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    document.addEventListener("focusin", soon);
    document.addEventListener("focusout", soon);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusin", soon);
      document.removeEventListener("focusout", soon);
    };
  }, []);
  return state;
}
