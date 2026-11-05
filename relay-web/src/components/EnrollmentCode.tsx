"use client";

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { useIdentity } from "@/context/IdentityContext";
import { ENROLLMENT_CODE_TTL_MS, fingerprint } from "@/lib/signed";

/**
 * This device's signed enrollment code as a QR + copyable text. Codes expire after 3 minutes,
 * so a fresh one is made automatically when the old one runs out.
 */
export function EnrollmentCode() {
  const { identity, createEnrollmentCode } = useIdentity();
  const [fp, setFp] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  const regenerate = useCallback(async () => {
    const next = await createEnrollmentCode();
    setCode(next);
    setExpiresAt(Date.now() + ENROLLMENT_CODE_TTL_MS);
    // A 4-square white border (the QR standard) so scanners can find the code against the dark app background.
    setQr(await QRCode.toDataURL(next, { errorCorrectionLevel: "L", margin: 4, width: 576 }));
    setCopied(false);
  }, [createEnrollmentCode]);

  useEffect(() => {
    regenerate();
  }, [regenerate]);

  useEffect(() => {
    if (identity) fingerprint(identity.publicKeyBase64).then(setFp);
  }, [identity]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (expiresAt && now >= expiresAt) regenerate();
  }, [now, expiresAt, regenerate]);

  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000));

  return (
    <div className="flex flex-col items-center gap-2">
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt="Enrollment QR code" className="w-72 h-72 max-w-full rounded bg-white" />
      ) : (
        <div className="w-72 h-72 max-w-full rounded bg-[var(--surface)]" />
      )}
      <p className="text-xs text-[var(--muted)]">
        Fingerprint <code>{fp}</code>
      </p>
      <p className="text-xs text-[var(--muted)]">
        Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!code}
          onClick={async () => {
            if (!code) return;
            await navigator.clipboard.writeText(code).catch(() => {});
            setCopied(true);
          }}
          className="px-3 py-1.5 rounded border border-[var(--border)] text-sm"
        >
          {copied ? "Copied" : "Copy code"}
        </button>
        <button type="button" onClick={regenerate} className="px-3 py-1.5 rounded border border-[var(--border)] text-sm">
          New code
        </button>
      </div>
    </div>
  );
}
