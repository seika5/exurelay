"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useIdentity } from "@/context/IdentityContext";
import { getServerStatus, type ServerStatus } from "@/lib/api";
import { createJoinCode, joinLink } from "@/lib/server";
import { blobSettings, directoryWithBlobSettings } from "@/lib/signed";
import { MAX_DECOYS } from "@/lib/sealed";
import { Icon, IconButton } from "@/components/icons";
import { btn, btnPrimary, field } from "@/components/ui";

/** The server's join link and code to copy, and on request the link as a QR (it opens this app). */
export function JoinCodePanel() {
  const { server } = useIdentity();
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const code = server && server.admins.length > 0 ? createJoinCode(server) : null;
  const link = code ? joinLink(code) : null;

  useEffect(() => {
    if (link && showQr) QRCode.toDataURL(link, { errorCorrectionLevel: "L", margin: 4, width: 576 }).then(setQr, () => setQr(null));
  }, [link, showQr]);

  if (!code || !link) return null;
  const copy = async (what: string, text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(what);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => copy("link", link)}>
          {copied === "link" ? "Copied" : "Copy link"}
        </button>
        <button type="button" className={btn} onClick={() => setShowQr(!showQr)} aria-expanded={showQr}>
          <Icon name="settingsQr" />
          {showQr ? "Hide QR" : "Show QR"}
        </button>
        <button type="button" className={btn} onClick={() => copy("code", code)}>
          {copied === "code" ? "Copied" : "Copy code"}
        </button>
      </div>
      {showQr && qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt="Join QR code" className="w-64 h-64 max-w-full self-center rounded bg-white" />
      )}
    </div>
  );
}

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const fmtTime = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

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
    <div className="flex flex-col gap-2 text-sm">
      <label className="flex flex-wrap items-center gap-2">
        Pad every message to
        <select value={size} onChange={(e) => setSize(Number(e.target.value))} className={field}>
          {BLOB_SIZES_KB.map((kb) => (
            <option key={kb} value={kb * 1024}>
              {kb} KB{kb === 64 ? " (default)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        Up to
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_DECOYS}
          value={decoys}
          onChange={(e) => setDecoys(Math.max(0, Math.min(MAX_DECOYS, Math.round(Number(e.target.value) || 0))))}
          className={`${field} w-16`}
        />
        decoys per send (default 3)
      </label>
      <p className="text-xs text-[var(--muted)]">
        A short text costs each member about {Math.round(((1 + decoys / 2) * size) / 1024)} KB.
      </p>
      <button
        type="button"
        disabled={!changed || busy}
        className={`${btnPrimary} self-start`}
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
      {message && <p className="text-xs text-[var(--muted)]">{message}</p>}
    </div>
  );
}

/** Server status for admins: counts only, no per-member activity (the server doesn't keep any). */
export function ServerStatusPanel() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    getServerStatus().then(setStatus, (e) => setError(e instanceof Error ? e.message : "Couldn't load status"));
  };
  useEffect(load, []);

  const refresh = <IconButton icon="refresh" label="Refresh" onClick={load} />;
  if (error)
    return (
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm text-red-500">{error}</p>
        {refresh}
      </div>
    );
  if (!status) return <p className="text-xs text-[var(--muted)]">Loading…</p>;
  const now = Date.now();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-start gap-2">
        <div className="flex-1 flex flex-col gap-1">
          <div>Members: {status.members}</div>
          <div>Stored: {fmtBytes(status.blobBytes)}</div>
          <div>{status.turn.configured ? "Call relay: on" : "Call relay: off. Some calls may not connect."}</div>
        </div>
        {refresh}
      </div>
      <details className="text-xs text-[var(--muted)]">
        <summary className="cursor-pointer py-1 touch:py-2 select-none">Technical details</summary>
        <div className="flex flex-col gap-1 pt-1">
          <div>Stored items: {status.blobs}</div>
          <div>Member list version: {status.directoryVersion}</div>
          <div>
            Tokens issued today (all members): {status.tokens.issuedToday} · limit {status.tokens.ratePerMinute}/min per member after a burst of{" "}
            {status.tokens.burst}
          </div>
          <div className="mt-1 font-medium text-[var(--text)]">Token keys</div>
          <ul className="flex flex-col gap-0.5">
            {status.issuerKeys.map((k) => (
              <li key={k.id} className={k.notAfter <= now ? "opacity-60" : ""}>
                <code>{k.id.slice(0, 8)}</code> {k.reason}
                {k.directoryVersion ? ` (list v${k.directoryVersion})` : ""} · {fmtTime(k.notBefore)} → {fmtTime(k.notAfter)}
                {k.notAfter <= now ? " · ended" : ""}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}
