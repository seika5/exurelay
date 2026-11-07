"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { confirmDialog } from "@/components/Modal";
import { btn } from "@/components/ui";
import { formatMB, shouldOfferSmaller } from "@/lib/imageSize";
import { decodeImage, shrinkImage } from "@/lib/shrinkImage";

// One batch at a time, so two quick picks don't ask two questions at once (confirmDialog shows one).
let queue: Promise<unknown> = Promise.resolve();

/**
 * Files about to be attached, however they came (picker, camera, paste, drop). A photo over 2 MB asks once whether
 * to send a smaller copy; one this browser can't open (HEIC outside Safari) is kept as it is without asking.
 */
export function prepareFiles(files: File[]): Promise<File[]> {
  const run = queue.then(async () => {
    const out: File[] = [];
    for (const f of files) out.push(await prepare(f));
    return out;
  });
  queue = run.catch(() => {});
  return run;
}

async function prepare(file: File): Promise<File> {
  if (!shouldOfferSmaller(file)) return file;
  const img = await decodeImage(file);
  if (!img) return file;
  const smaller = await confirmDialog(`This photo is ${formatMB(file.size)}. Send a smaller copy?`, { ok: "Smaller", cancel: "Original" });
  if (!smaller) return file;
  const copy = await shrinkImage(file, img).catch(() => null);
  return copy && copy.size < file.size ? copy : file;
}

const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/** Dragging files over the chat (desktop): whether they're over it, and the handlers to put on it. */
export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child crossed, so count them.
  const depth = useRef(0);
  useEffect(() => {
    if (enabled) return;
    depth.current = 0;
    setOver(false);
  }, [enabled]);
  useEffect(() => {
    // A drag that ends somewhere else (or is cancelled) never sends the last dragleave.
    const reset = () => {
      depth.current = 0;
      setOver(false);
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, []);
  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!enabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length) onFiles(files);
    },
  };
  return { over, handlers };
}

/** Shown over the chat while files are dragged onto it. */
export function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[var(--accent)] bg-black/60 text-white text-sm font-medium">
      <Icon name="attach" size={28} />
      Drop to attach
    </div>
  );
}

const square = `${btn} flex-shrink-0 h-[42px] w-[42px] p-0 cursor-pointer select-none`;

/**
 * The composer's attach button. With a mouse it opens the file picker; on a touch screen it offers the camera too
 * ("Photo or video") or the picker ("Choose file").
 */
export function AttachButton({ touch, onFiles }: { touch: boolean; onFiles: (files: File[]) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onFiles(files);
    e.target.value = "";
  };
  const item = "flex items-center gap-2 px-3 py-2.5 min-h-11 rounded text-sm whitespace-nowrap cursor-pointer select-none hover:bg-white/5";

  return (
    <div ref={wrap} className="relative flex-shrink-0">
      {/*
        sr-only keeps the inputs in the DOM (not display:none) so iOS Safari recognises the label click as a real
        user gesture and opens the picker or camera.
      */}
      <input id="relay-file-input" ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} onChange={picked} />
      <input id="relay-camera-input" type="file" accept="image/*,video/*" capture="environment" className="sr-only" tabIndex={-1} onChange={picked} />
      {touch ? (
        <button
          type="button"
          aria-label="Attach file"
          title="Attach file"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={square}
        >
          <Icon name="attach" size={18} />
        </button>
      ) : (
        <label
          htmlFor="relay-file-input"
          role="button"
          tabIndex={0}
          aria-label="Attach file"
          title="Attach file"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInput.current?.click();
            }
          }}
          className={square}
        >
          <Icon name="attach" size={18} />
        </label>
      )}
      {/* Hidden rather than removed when closed: a label taken out of the page as it's tapped may not open its input. */}
      {touch && (
        <div
          role="menu"
          aria-label="Attach"
          className={`absolute bottom-full left-0 mb-2 z-20 flex-col p-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg ${open ? "flex" : "hidden"}`}
        >
          <label htmlFor="relay-camera-input" role="menuitem" className={item} onClick={() => setOpen(false)}>
            <Icon name="chatCamera" size={18} />
            Photo or video
          </label>
          <label htmlFor="relay-file-input" role="menuitem" className={item} onClick={() => setOpen(false)}>
            <Icon name="chatFile" size={18} />
            Choose file
          </label>
        </div>
      )}
    </div>
  );
}
