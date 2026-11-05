"use client";

import { useEffect, useState } from "react";

/**
 * The part of the screen not covered by the on-screen keyboard. iOS doesn't resize the page when the keyboard opens:
 * it scrolls the whole page to keep the focused field visible, which pushes a full-height layout's header off the top
 * and leaves a gap that depends on how far it scrolled. A layout pinned to this area (top and height) stays put
 * instead. `keyboard` is true while the keyboard covers part of the screen.
 */
export function useVisibleViewport(): { top: number; height: number | null; keyboard: boolean } {
  const [state, setState] = useState<{ top: number; height: number | null; keyboard: boolean }>({ top: 0, height: null, keyboard: false });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // The page itself must not scroll: everything scrollable lives inside the layout.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
      setState({ top: vv.offsetTop, height: vv.height, keyboard: vv.height < window.innerHeight - 100 });
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return state;
}
