"use client";

import { useRef, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { avatarColor, encodeAvatar, initialOf } from "@/lib/avatar";
import { Icon, IconButton } from "@/components/icons";

/**
 * A member's profile picture, or their initial on a color from their key hash. Size and text size come from
 * `className` (e.g. "h-8 w-8 text-sm"). Decorative: the name is always shown or read out next to it.
 */
export function Avatar({ keyHash, name, className = "h-8 w-8 text-sm" }: { keyHash: string; name?: string; className?: string }) {
  const { avatarOf } = useIdentity();
  const src = avatarOf(keyHash);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- a data URL, nothing for next/image to optimize
    <img src={src} alt="" aria-hidden="true" draggable={false} className={`shrink-0 rounded-full object-cover select-none ${className}`} />
  ) : (
    <span
      aria-hidden="true"
      className={`shrink-0 rounded-full inline-flex items-center justify-center font-semibold text-white select-none leading-none ${className}`}
      style={{ backgroundColor: avatarColor(keyHash) }}
    >
      {initialOf(name)}
    </span>
  );
}

/** Settings → General: my picture. Tap it to pick an image (cropped, shrunk and re-encoded to fit), or remove it. */
export function AvatarPicker() {
  const { identity, avatarOf, setMyAvatar } = useIdentity();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!identity) return null;
  const has = !!avatarOf(identity.keyHash);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label="Choose profile picture"
          title="Choose profile picture"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="relative shrink-0 rounded-full disabled:opacity-50"
        >
          <Avatar keyHash={identity.keyHash} name={identity.myName} className="h-14 w-14 text-xl" />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]">
            <Icon name="chatPencil" size={12} />
          </span>
        </button>
        {has && <IconButton icon="trash" label="Remove profile picture" disabled={busy} onClick={() => setMyAvatar(null)} />}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        aria-label="Profile picture file"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            // Any size works: it's cropped, shrunk and re-encoded until it fits. Only an unreadable file fails.
            setMyAvatar(await encodeAvatar(file));
          } catch {
            setError("Couldn't read that image");
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
