"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useIdentity } from "@/context/IdentityContext";
import { getServerStatus, type ServerStatus } from "@/lib/api";
import { createJoinCode, joinLink } from "@/lib/server";
import { blobSettings, directoryWithBlobSettings } from "@/lib/signed";
import { MAX_DECOYS } from "@/lib/sealed";

const button = "px-3 py-1.5 rounded border border-[var(--border)] text-sm";

/** The server's join code as a QR (a link that opens this app) plus copyable link and code. */
export function JoinCodePanel() {
  const { server } = useIdentity();
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const code = server && server.admins.length > 0 ? createJoinCode(server) : null;
  const link = code ? joinLink(code) : null;

  useEffect(() => {
    if (link) QRCode.toDataURL(link, { errorCorrectionLevel: "L", margin: 4, width: 576 }).then(setQr, () => setQr(null));
  }, [link]);

  if (!code || !link) return null;
  const copy = async (what: string, text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(what);
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-xs text-[var(--muted)]">
        New members scan this (or open the link) to point their app at this server. It isn&apos;t secret, but it carries the
        admin keys their app will trust, so hand it over directly. They still need to be enrolled.
      </p>
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt="Join QR code" className="w-64 h-64 max-w-full rounded bg-white" />
      )}
      <div className="flex gap-2">
        <button type="button" className={button} onClick={() => copy("link", link)}>
          {copied === "link" ? "Copied" : "Copy link"}
        </button>
        <button type="button" className={button} onClick={() => copy("code", code)}>
          {copied === "code" ? "Copied" : "Copy code"}
        </button>
      </div>
    </div>
  );
}

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const fmtTime = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

/** Server status for admins: counts only, no per-member activity (the server doesn't keep any). */
const BLOB_SIZES_KB = [16, 32, 64, 128, 256];

/**
 * Protocol v2 blob settings, signed into the member list so the admin (not the server operator) controls them.
 * Every blob on the server has this size; each send adds 0 to `decoys` random blobs.
 */
export function BlobSettingsPanel() {
  const { directory, identity, publishSignedDirectory } = useIdentity();
  const current = blobSettings(directory);
  const [size, setSize] = useState(current.blobSize);
  const [decoys, setDecoys] = useState(current.decoys);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!directory || !identity) return null;
  const changed = size !== current.blobSize || decoys !== current.decoys;
  // Each send is about (blobs for the content) + decoys/2 extra blobs, downloaded by every member.
  return (
    <div className="flex flex-col gap-2 text-xs">
      <p className="text-[var(--muted)]">
        Every message, file and call note is stored as blobs of one size, so the server can&apos;t tell them apart, and
        every member downloads every blob. Bigger blobs hide longer messages but cost more data; decoys hide how many
        blobs a send really needs.
      </p>
      <label className="flex items-center gap-2">
        Blob size
        <select value={size} onChange={(e) => setSize(Number(e.target.value))} className="px-2 py-1 rounded bg-[var(--bg)] border border-[var(--border)]">
          {BLOB_SIZES_KB.map((kb) => (
            <option key={kb} value={kb * 1024}>
              {kb} KB{kb === 64 ? " (default)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        Up to
        <input
          type="number"
          min={0}
          max={MAX_DECOYS}
          value={decoys}
          onChange={(e) => setDecoys(Math.max(0, Math.min(MAX_DECOYS, Math.round(Number(e.target.value) || 0))))}
          className="w-16 px-2 py-1 rounded bg-[var(--bg)] border border-[var(--border)]"
        />
        decoy blobs per send (default 3)
      </label>
      <p className="text-[var(--muted)]">
        A short text costs each member about {Math.round(((1 + decoys / 2) * size) / 1024)} KB to download.
      </p>
      <button
        type="button"
        disabled={!changed || busy}
        className={`${button} self-start disabled:opacity-50`}
        onClick={async () => {
          setBusy(true);
          setMessage(null);
          try {
            await publishSignedDirectory(directoryWithBlobSettings(directory, identity.signingPublicKeyBase64, size, decoys));
            setMessage("Saved. New sends use these settings.");
          } catch (e) {
            setMessage(e instanceof Error ? e.message : "Couldn't save");
          } finally {
            setBusy(false);
          }
        }}
      >
        Save
      </button>
      {message && <p className="text-[var(--muted)]">{message}</p>}
    </div>
  );
}

export function ServerStatusPanel() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    getServerStatus().then(setStatus, (e) => setError(e instanceof Error ? e.message : "Couldn't load status"));
  };
  useEffect(load, []);

  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!status) return <p className="text-xs text-[var(--muted)]">Loading…</p>;
  const now = Date.now();
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div>Members: {status.members}</div>
      <div>
        Blobs stored: {status.blobs} ({fmtBytes(status.blobBytes)})
      </div>
      <div>Member list version: {status.directoryVersion}</div>
      <div>
        Tokens issued today (all members): {status.tokens.issuedToday} · limit {status.tokens.ratePerMinute}/min per member after a burst of {status.tokens.burst}
      </div>
      <div>TURN: {status.turn.configured ? "configured" : "not configured (calls use public STUN only)"}</div>
      <div className="mt-1 font-medium">Token keys</div>
      <ul className="flex flex-col gap-0.5">
        {status.issuerKeys.map((k) => (
          <li key={k.id} className={k.notAfter <= now ? "text-[var(--muted)]" : ""}>
            <code>{k.id.slice(0, 8)}</code> {k.reason}
            {k.directoryVersion ? ` (list v${k.directoryVersion})` : ""} · {fmtTime(k.notBefore)} → {fmtTime(k.notAfter)}
            {k.notAfter <= now ? " · ended" : ""}
          </li>
        ))}
      </ul>
      <button type="button" className={`${button} self-start mt-1`} onClick={load}>
        Refresh
      </button>
    </div>
  );
}
