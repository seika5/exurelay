"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useIdentity } from "@/context/IdentityContext";
import { getServerStatus, type ServerStatus } from "@/lib/api";
import { createJoinCode, joinLink } from "@/lib/server";

const button = "px-3 py-1.5 rounded border border-[var(--border)] text-sm";

/** The server's join code as a QR (a link that opens this app) plus copyable link and code. */
export function JoinCodePanel() {
  const { server } = useIdentity();
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const code = server && server.admins.length > 0 ? createJoinCode(server) : null;
  const link = code ? joinLink(code) : null;

  useEffect(() => {
    if (link) QRCode.toDataURL(link, { errorCorrectionLevel: "L", margin: 1, width: 280 }).then(setQr, () => setQr(null));
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
        <img src={qr} alt="Join QR code" className="w-48 h-48 rounded bg-white" />
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
