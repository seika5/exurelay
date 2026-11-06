"use client";

import { useEffect, useState } from "react";
import { Icon, IconButton } from "@/components/icons";

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
 * A file in a message. Photos, videos and audio get a Show button next to Download, and show here. The file's data is
 * only turned into something viewable when Show is pressed.
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

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  // Tells the message list a size change is coming, so it can keep what's below this file in place (page.tsx).
  const soon = (e: React.MouseEvent) => e.currentTarget.dispatchEvent(new Event("relay:resize-soon", { bubbles: true }));
  const show = () => {
    setFailed(false);
    if (!url) {
      const bin = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
      setUrl(URL.createObjectURL(new Blob([bin], { type: MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "" })));
    }
    setShown(true);
  };
  const open = shown && !!url && !failed;


  return (
    <span className="inline-flex flex-col gap-1 max-w-full">
      {open && kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name} onError={() => setFailed(true)} className="max-w-full max-h-80 self-start rounded border border-[var(--border)]" />
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
