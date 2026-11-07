"use client";

import { useEffect, useRef, useState } from "react";
import { useDoubleTap } from "@/lib/doubleTap";
import { getQuickEmoji } from "@/lib/emoji";
import { createPortal } from "react-dom";
import { Icon, IconButton } from "@/components/icons";
import { isVoiceName } from "@/lib/voice";

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
  // A recorded voice message in WebM is sound only.
  if (isVoiceName(filename)) return "audio";
  return KINDS[filename.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

const mimeFor = (name: string) => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return isVoiceName(name) && ext === "webm" ? "audio/webm" : MIME[ext] ?? "";
};

/**
 * A file in a message. Photos, videos and audio get a Show button next to Download, and show here. The file's data is
 * only turned into something viewable when Show is pressed, except a voice message's, whose player shows at once.
 */
export function ChatFile({
  name,
  size,
  body,
  removed,
  onDownload,
  onDoubleTap,
}: {
  name: string;
  /** e.g. "1.2 MB", or null when unknown. */
  size: string | null;
  /** The file, base64. */
  body: string;
  removed?: boolean;
  onDownload: () => void;
  /** Phones: a double tap on the photo or video (here or full screen) reacts to its message. */
  onDoubleTap?: () => void;
}) {
  const kind = removed ? null : mediaKind(name);
  const [url, setUrl] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Phones: one tap opens it full screen (once it's clear no second tap is coming), a double tap reacts.
  const touched = useRef(false);
  const taps = useDoubleTap(
    () => onDoubleTap?.(),
    () => setExpanded(true)
  );

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  // Tells the message list a size change is coming, so it can keep what's below this file in place (page.tsx).
  const soon = (e: React.MouseEvent) => e.currentTarget.dispatchEvent(new Event("relay:resize-soon", { bubbles: true }));
  const show = () => {
    setFailed(false);
    if (!url) {
      const bin = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
      setUrl(URL.createObjectURL(new Blob([bin], { type: mimeFor(name) })));
    }
    setShown(true);
  };
  // Voice messages are there to be played: the player shows at once, with no Show button.
  const voice = kind === "audio" && isVoiceName(name);
  useEffect(() => {
    if (voice) show();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice]);
  const open = shown && !!url && !failed;


  return (
    <span className="inline-flex flex-col gap-1 max-w-full">
      {/* Photos and videos open full screen when tapped (videos play there). */}
      {open && (kind === "image" || kind === "video") && (
        <button
          type="button"
          aria-label={`Open ${name}`}
          onPointerDown={(e) => {
            touched.current = e.pointerType === "touch";
            taps.onPointerDown(e);
          }}
          onPointerUp={taps.onPointerUp}
          onPointerCancel={taps.onPointerCancel}
          // A mouse opens it at once; a touch waits for the tap handling above.
          onClick={() => !touched.current && setExpanded(true)}
          style={{ touchAction: "manipulation" }}
          className="relative self-start max-w-full rounded border border-[var(--border)] overflow-hidden cursor-zoom-in"
        >
          {kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={name} onError={() => setFailed(true)} className="block max-w-full max-h-80" />
          ) : (
            <>
              {/* #t=0.1: iPhone shows the first frame instead of a blank box. */}
              <video src={`${url}#t=0.1`} muted playsInline preload="metadata" onError={() => setFailed(true)} className="block max-w-full max-h-80 pointer-events-none" />
              <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white">
                  <svg viewBox="0 0 24 24" width={22} height={22} fill="currentColor"><path d="M8 5.5v13l10.5-6.5z" /></svg>
                </span>
              </span>
            </>
          )}
        </button>
      )}
      {open && expanded && url && (kind === "image" || kind === "video") && (
        <MediaViewer kind={kind} url={url} name={name} onDownload={onDownload} onDoubleTap={onDoubleTap} onClose={() => setExpanded(false)} />
      )}
      {open && kind === "audio" && <AudioPlayer url={url} name={name} onError={() => setFailed(true)} />}
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 max-w-full">
        <span className="inline-flex items-center gap-2 min-w-0 max-w-full rounded border border-[var(--border)] bg-[var(--surface)] pl-2 pr-1 py-1">
          <Icon name="chatFile" />
          <span className="min-w-0 truncate">{name}</span>
          {size && <span className="shrink-0 text-xs text-[var(--muted)]">· {size}</span>}
          {kind &&
            !voice &&
            (open ? (
              <IconButton icon="chatHide" label={`Hide ${name}`} onClick={(e) => { soon(e); setShown(false); }} />
            ) : (
              <IconButton icon="chatShow" label={`Show ${name}`} onClick={(e) => { soon(e); show(); }} />
            ))}
          {!removed && <IconButton icon="chatDownload" label={`Download ${name}`} onClick={onDownload} />}
        </span>
        {removed && <span className="text-xs text-[var(--muted)]">Removed from this device</span>}
        {failed && <span className="text-xs text-red-500">Failed to load</span>}
      </span>
    </span>
  );
}

/** A photo or video full screen, with Download and Close at the top. Escape or a tap outside the media closes it. */
function MediaViewer({
  kind,
  url,
  name,
  onDownload,
  onDoubleTap,
  onClose,
}: {
  kind: "image" | "video";
  url: string;
  name: string;
  onDownload: () => void;
  onDoubleTap?: () => void;
  onClose: () => void;
}) {
  // A double tap reacts: show it, since the message isn't on screen.
  const [burst, setBurst] = useState<string | null>(null);
  const react = onDoubleTap
    ? () => {
        onDoubleTap();
        setBurst(getQuickEmoji()[0]);
        setTimeout(() => setBurst(null), 700);
      }
    : undefined;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  // On the page itself, not inside the chat: the chat moves with the keyboard, which would carry this with it.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-50 flex flex-col bg-black"
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative z-10 flex items-center gap-2 p-2">
        <span className="flex-1 min-w-0 truncate text-sm text-white/80 pl-1">{name}</span>
        <IconButton icon="chatDownload" label={`Download ${name}`} onClick={onDownload} />
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>
      <div className="relative flex-1 min-h-0 flex items-center justify-center p-2 overflow-hidden" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {burst && (
          <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-7xl animate-ping" aria-live="polite" aria-label={`Reacted ${burst}`}>
            {burst}
          </span>
        )}
        {kind === "image" ? (
          <ZoomableImage url={url} name={name} onDoubleTap={react} />
        ) : (
          <video src={url} controls playsInline className="w-full h-full object-contain" />
        )}
      </div>
    </div>,
    document.body
  );
}

type View = { s: number; x: number; y: number };
const MAX_ZOOM = 5;

/**
 * A photo scaled to fit the screen. On a touch screen, pinch to zoom (up to 5x) and drag to move around while zoomed
 * in; letting go below 1x snaps back to fit. A mouse can't zoom it (for now).
 */
function ZoomableImage({ url, name, onDoubleTap }: { url: string; name: string; onDoubleTap?: () => void }) {
  const taps = useDoubleTap(() => onDoubleTap?.());
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const live = useRef(view);
  live.current = view;
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; mid: { x: number; y: number }; start: View } | null>(null);

  // Keep the photo covering the screen as far as it can: no dragging it off into empty space.
  const clamp = (v: View): View => {
    const el = img.current;
    if (!el) return v;
    const maxX = Math.max(0, (el.clientWidth * v.s - el.clientWidth) / 2);
    const maxY = Math.max(0, (el.clientHeight * v.s - el.clientHeight) / 2);
    return { s: v.s, x: Math.max(-maxX, Math.min(maxX, v.x)), y: Math.max(-maxY, Math.min(maxY, v.y)) };
  };
  const pair = () => {
    const [a, b] = [...touches.current.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  const begin = () => {
    if (touches.current.size === 2) {
      const p = pair();
      gesture.current = { ...p, start: live.current };
    } else if (touches.current.size === 1) {
      const [t] = [...touches.current.values()];
      gesture.current = { dist: 0, mid: t, start: live.current };
    } else gesture.current = null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (e.pointerType !== "touch") return;
    taps.onPointerDown(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    begin();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!touches.current.has(e.pointerId) || !gesture.current) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (touches.current.size === 2) {
      const p = pair();
      const s = Math.max(0.5, Math.min(MAX_ZOOM, (g.start.s * p.dist) / g.dist));
      setView(clamp({ s, x: g.start.x + (p.mid.x - g.mid.x), y: g.start.y + (p.mid.y - g.mid.y) }));
    } else if (touches.current.size === 1 && g.start.s > 1) {
      const [t] = [...touches.current.values()];
      setView(clamp({ s: g.start.s, x: g.start.x + (t.x - g.mid.x), y: g.start.y + (t.y - g.mid.y) }));
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    if (e.type === "pointercancel") taps.onPointerCancel(e);
    else taps.onPointerUp(e);
    if (!touches.current.delete(e.pointerId)) return;
    if (touches.current.size === 0 && live.current.s <= 1) setView({ s: 1, x: 0, y: 0 });
    begin();
  };

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={img}
      src={url}
      alt={name}
      draggable={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="w-full h-full object-contain touch-none select-none"
      style={{
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
        transition: touches.current.size ? "none" : "transform 150ms ease-out",
      }}
    />
  );
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Audio and voice messages: play/pause, a seek bar and the time, in the app's own colors (the browser's player is a
 * bright white pill). Recordings from some browsers don't say how long they are until played through; then only the
 * time played shows.
 */
function AudioPlayer({ url, name, onError }: { url: string; name: string; onError: () => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState<number | null>(null);
  const known = length !== null && Number.isFinite(length) && length > 0;
  return (
    <span className="inline-flex items-center gap-2 max-w-full w-72 rounded-md border border-[var(--border)] bg-[var(--surface)] p-1.5 pr-3">
      <audio
        ref={audio}
        src={url}
        preload="metadata"
        onError={onError}
        onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
        onDurationChange={(e) => setLength(e.currentTarget.duration)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
        className="hidden"
      />
      <button
        type="button"
        aria-label={playing ? `Pause ${name}` : `Play ${name}`}
        onClick={() => (playing ? audio.current?.pause() : audio.current?.play().catch(() => {}))}
        className="inline-flex h-8 w-8 touch:h-10 touch:w-10 shrink-0 items-center justify-center rounded bg-[var(--bg)] text-[var(--text)] hover:bg-white/10"
      >
        <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden>
          {playing ? <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /> : <path d="M8 5.5v13l10.5-6.5z" />}
        </svg>
      </button>
      <input
        type="range"
        min={0}
        max={known ? length! : 1}
        step="any"
        value={known ? at : 0}
        disabled={!known}
        aria-label={`Position in ${name}`}
        onChange={(e) => {
          if (audio.current) audio.current.currentTime = Number(e.target.value);
        }}
        className="flex-1 min-w-0 h-1 accent-[var(--muted)]"
      />
      <span className="shrink-0 text-xs tabular-nums text-[var(--muted)]">{known ? `${clock(at)} / ${clock(length!)}` : clock(at)}</span>
    </span>
  );
}
