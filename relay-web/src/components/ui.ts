/**
 * Shared button styles. Every button has a border or a fill (no bare-text buttons), and a 40px tap height on touch
 * screens (`touch:` is `(pointer: coarse)`, tailwind.config.ts).
 */

const base =
  "inline-flex items-center justify-center gap-1.5 px-3 py-1.5 touch:min-h-10 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed";

/** Ordinary action. */
export const btn = `${base} border border-[var(--border)] hover:bg-white/5`;
/** The main action of a screen or form. */
export const btnPrimary = `${base} bg-[var(--accent)] text-on-accent font-medium hover:opacity-90`;
/** Removes or ends something. */
export const btnDanger = `${base} border border-red-500/50 text-red-400 hover:bg-red-500/10`;
/** A smaller ordinary button, for dense rows (still 40px tall on touch screens). */
export const btnSmall = `inline-flex items-center justify-center gap-1 px-2 py-1 touch:min-h-10 rounded text-xs border border-[var(--border)] hover:bg-white/5 disabled:opacity-50`;
/** Text inputs and selects. */
export const field = "px-3 py-2 rounded bg-[var(--bg)] border border-[var(--border)] text-sm";
/** A bordered list that scrolls inside its box, with a scrollbar that always shows (globals.css). Rows go in <li>s. */
export const scrollList = "scroll-visible flex flex-col max-h-60 overflow-auto rounded border border-[var(--border)] divide-y divide-[var(--border)]";
