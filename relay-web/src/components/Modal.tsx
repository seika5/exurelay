"use client";

import { useEffect, useRef, useState } from "react";
import { btn, btnDanger, btnPrimary } from "@/components/ui";

/**
 * A dialog: full screen on phones (clear of the notch and home bar), a card near the top on larger screens.
 * Escape or a tap outside the card closes it; focus moves into it when it opens.
 */
export function Modal({
  onClose,
  title,
  children,
  wide = false,
  compact = false,
  closeLabel = "Done",
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** 512px instead of 448px on larger screens. */
  wide?: boolean;
  /** A small centered card on phones too (short dialogs: a name, a list), instead of a full-screen sheet. */
  compact?: boolean;
  /** The header button's label; null for none (e.g. when the dialog has its own buttons). */
  closeLabel?: string | null;
}) {
  const card = useRef<HTMLDivElement>(null);
  // The latest onClose, so callers can pass an inline function without re-running the effect (which would also
  // pull focus out of whatever field is being typed in).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("keydown", onKey);
    card.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className={`fixed inset-0 z-30 bg-black/60 flex justify-center ${compact ? "items-center p-4" : "sm:items-start sm:p-4 sm:pt-[8vh]"}`}
      onMouseDown={(e) => e.target === e.currentTarget && close.current()}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={
          compact
            ? "bg-[var(--surface)] w-full max-w-sm max-h-[80vh] overflow-auto flex flex-col gap-4 outline-none rounded-lg border border-[var(--border)] p-4"
            : `bg-[var(--surface)] w-full h-full overflow-auto flex flex-col gap-4 outline-none sm:h-auto sm:max-h-[84vh] sm:rounded-lg sm:border sm:border-[var(--border)] ${wide ? "sm:max-w-lg" : "sm:max-w-md"}`
        }
        style={
          compact
            ? undefined
            : {
                paddingTop: "max(1rem, env(safe-area-inset-top, 0px))",
                paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))",
                paddingLeft: "max(1rem, env(safe-area-inset-left, 0px))",
                paddingRight: "max(1rem, env(safe-area-inset-right, 0px))",
              }
        }
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">{title}</h2>
          {closeLabel && (
            <button type="button" onClick={onClose} className={btn}>
              {closeLabel}
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

type ConfirmRequest = { message: string; ok: string; danger: boolean; resolve: (yes: boolean) => void };
let show: ((r: ConfirmRequest) => void) | null = null;

/**
 * Ask before doing something, with an in-app dialog (the browser's own confirm shows the site address as its title on
 * an installed iPhone app, and its OK looks the same for "Remove" as for anything else). Falls back to the browser's
 * confirm if no ConfirmHost is mounted.
 */
export function confirmDialog(message: string, opts: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  if (!show) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => show!({ message, ok: opts.ok ?? "OK", danger: opts.danger ?? false, resolve }));
}

/** Mounted once (layout.tsx): shows confirmDialog's questions. */
export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  useEffect(() => {
    show = setReq;
    return () => {
      show = null;
    };
  }, []);
  if (!req) return null;
  const answer = (yes: boolean) => {
    req.resolve(yes);
    setReq(null);
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm"
        className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-4"
        onKeyDown={(e) => e.key === "Escape" && answer(false)}
      >
        <p className="text-sm whitespace-pre-wrap">{req.message}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={() => answer(false)}>
            Cancel
          </button>
          <button type="button" autoFocus className={req.danger ? btnDanger : btnPrimary} onClick={() => answer(true)}>
            {req.ok}
          </button>
        </div>
      </div>
    </div>
  );
}

/** An on/off switch. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 touch:my-2 ${on ? "bg-[var(--accent)]" : "bg-[var(--switch-off)]"}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}
