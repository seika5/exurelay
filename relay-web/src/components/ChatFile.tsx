"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, IconButton, type IconName } from "@/components/icons";

type Kind = "image" | "video" | "audio" | null;

const KINDS: Record<string, Kind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", heic: "image", heif: "image",
  mp4: "video", mov: "video", m4v: "video", webm: "video",
  mp3: "audio", m4a: "audio", aac: "audio", wav: "audio", ogg: "audio", opus: "audio",
};
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  heic: "image/heic", heif: "image/heif", mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg",
};

/** Photos, videos and audio the app can show itself. SVG isn't one: it can carry code, so it stays a download. */
export function mediaKind(filename: string): Kind {
  return KINDS[filename.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/**
 * A file in a message. Photos, videos and audio get a Show button next to Download, and show here. Press and hold (or
 * right-click) any file for a menu with the same actions.
 */
export function ChatFile({
  name,
  size,
  body,
  removed,
  onDownload,
}: {
  name: string;
  /** e.g. "1.2 MB", or null when unknown. */
  size: string | null;
  /** The file, base64. */
  body: string;
  removed?: boolean;
  onDownload: () => void;
}) {
  const kind = removed ? null : mediaKind(name);
  const [url, setUrl] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const [menu, setMenu] = useState<"up" | "down" | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  // The menu closes on a tap elsewhere or Escape.
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setMenu(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  const show = () => {
    setFailed(false);
    if (!url) {
      const bin = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
      setUrl(URL.createObjectURL(new Blob([bin], { type: MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "" })));
    }
    setShown(true);
  };
  const open = shown && !!url && !failed;

  const stop = () => hold.current && clearTimeout(hold.current);
  // Opens above the file, or below it when it's near the top of the screen.
  const openMenu = () => setMenu((box.current?.getBoundingClientRect().top ?? 999) < 160 ? "down" : "up");
  const holdHandlers = removed
    ? {}
    : {
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          openMenu();
        },
        onPointerDown: (e: React.PointerEvent) => {
          if (e.pointerType === "mouse") return;
          stop();
          start.current = { x: e.clientX, y: e.clientY };
          hold.current = setTimeout(openMenu, 500);
        },
        onPointerUp: stop,
        onPointerLeave: stop,
        onPointerCancel: stop,
        onPointerMove: (e: React.PointerEvent) => (Math.abs(e.clientX - start.current.x) > 8 || Math.abs(e.clientY - start.current.y) > 8) && stop(),
        style: { WebkitTouchCallout: "none", WebkitUserSelect: "none" } as React.CSSProperties,
      };

  const item = (icon: IconName, label: string, act: () => void) => (
    <button
      type="button"
      role="menuitem"
      className="flex items-center gap-2 w-full px-3 py-2 touch:py-3 text-sm text-left hover:bg-white/5"
      onClick={() => {
        setMenu(null);
        act();
      }}
    >
      <Icon name={icon} />
      {label}
    </button>
  );

  return (
    <span ref={box} className="relative inline-flex flex-col gap-1 max-w-full" {...holdHandlers}>
      {open && kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name} draggable={false} onError={() => setFailed(true)} className="max-w-full max-h-80 self-start rounded border border-[var(--border)]" />
      )}
      {open && kind === "video" && (
        <video src={url} controls playsInline onError={() => setFailed(true)} className="max-w-full max-h-80 self-start rounded border border-[var(--border)]" />
      )}
      {open && kind === "audio" && <audio src={url} controls onError={() => setFailed(true)} className="max-w-full" />}
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 max-w-full">
        <span className="inline-flex items-center gap-2 min-w-0 max-w-full rounded border border-[var(--border)] bg-[var(--surface)] pl-2 pr-1 py-1">
          <Icon name="chatFile" />
          <span className="min-w-0 truncate">{name}</span>
          {size && <span className="shrink-0 text-xs text-[var(--muted)]">· {size}</span>}
          {kind &&
            (open ? (
              <IconButton icon="chatHide" label={`Hide ${name}`} onClick={() => setShown(false)} />
            ) : (
              <IconButton icon="chatShow" label={`Show ${name}`} onClick={show} />
            ))}
          {!removed && <IconButton icon="chatDownload" label={`Download ${name}`} onClick={onDownload} />}
        </span>
        {removed && <span className="text-xs text-[var(--muted)]">Removed from this device</span>}
        {failed && <span className="text-xs text-red-500">Failed to load</span>}
      </span>
      {menu && (
        <span
          role="menu"
          aria-label={name}
          className={`absolute left-0 z-20 ${menu === "up" ? "bottom-full mb-1" : "top-full mt-1"} min-w-40 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg`}
        >
          {kind && (open ? item("chatHide", "Hide", () => setShown(false)) : item("chatShow", "Show", show))}
          {item("chatDownload", "Download", onDownload)}
        </span>
      )}
    </span>
  );
}
