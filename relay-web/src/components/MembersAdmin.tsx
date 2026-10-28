"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import {
  directoryWithMember,
  directoryWithoutMember,
  fingerprint,
  readEnrollmentCode,
  type DirectoryMember,
  type EnrollmentRequest,
} from "@/lib/signed";

const button = "px-3 py-1.5 rounded border border-[var(--border)] text-sm disabled:opacity-50";
const primary = "px-3 py-1.5 rounded bg-[var(--accent)] text-white text-sm disabled:opacity-50";

function Fingerprint({ keyB64 }: { keyB64: string }) {
  const [fp, setFp] = useState("");
  useEffect(() => {
    fingerprint(keyB64).then(setFp);
  }, [keyB64]);
  return <code className="text-xs text-[var(--muted)]">{fp}</code>;
}

type Pending = { request: EnrollmentRequest; keyHash: string };

/**
 * Admin-only member management: create the directory, enroll from a pasted enrollment code, remove members.
 * Every change is a new directory version signed on this device; the server can't make these changes itself.
 */
export function MembersAdmin() {
  const { identity, directory, isAdmin, publishSignedDirectory, getDisplayName } = useIdentity();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [replaces, setReplaces] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!identity || !isAdmin) return null;
  const me = identity.signingPublicKeyBase64;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  if (!directory) {
    return (
      <div className="flex flex-col gap-2 items-center">
        <button
          type="button"
          disabled={busy}
          className={primary}
          onClick={() =>
            run(() =>
              publishSignedDirectory(
                directoryWithMember(null, me, {
                  keyHash: identity.keyHash,
                  ecdh: identity.publicKeyBase64,
                  sig: me,
                  enrolledAt: Date.now(),
                })
              )
            )
          }
        >
          {busy ? "Publishing…" : "Create member list"}
        </button>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    );
  }

  const checkCode = () =>
    run(async () => {
      const result = await readEnrollmentCode(code);
      if (!result.ok) throw new Error(result.error);
      if (directory.members.some((m) => m.keyHash === result.keyHash)) throw new Error("That key is already enrolled.");
      setPending({ request: result.request, keyHash: result.keyHash });
      setReplaces("");
    });

  const confirmEnroll = () =>
    run(async () => {
      if (!pending) return;
      // The code expires after 3 minutes: check again in case the admin waited on this screen.
      const fresh = await readEnrollmentCode(code);
      if (!fresh.ok) throw new Error(fresh.error);
      const member: DirectoryMember = {
        keyHash: pending.keyHash,
        ecdh: pending.request.ecdh,
        sig: pending.request.sig,
        enrolledAt: Date.now(),
        ...(replaces ? { replaces } : {}),
      };
      await publishSignedDirectory(directoryWithMember(directory, me, member));
      setPending(null);
      setCode("");
    });

  const remove = (m: DirectoryMember) => {
    const label = getDisplayName(m.keyHash) || m.keyHash.slice(0, 8);
    if (!window.confirm(`Remove ${label}? They'll no longer be able to use this server.`)) return;
    run(() => publishSignedDirectory(directoryWithoutMember(directory, me, m.keyHash)));
  };

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1 max-h-56 overflow-auto">
        {directory.members.map((m) => (
          <li key={m.keyHash} className="flex items-center gap-2 py-1">
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">
                {getDisplayName(m.keyHash) || m.keyHash.slice(0, 8)}
                {m.keyHash === identity.keyHash && <span className="text-[var(--muted)]"> (you)</span>}
              </div>
              <div className="flex gap-2 items-center">
                <Fingerprint keyB64={m.ecdh} />
                <span className="text-xs text-[var(--muted)]">{new Date(m.enrolledAt).toLocaleDateString()}</span>
              </div>
            </div>
            {m.keyHash !== identity.keyHash && (
              <button type="button" disabled={busy} className={button} onClick={() => remove(m)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="border-t border-[var(--border)] pt-3 flex flex-col gap-2">
        <h3 className="text-sm font-medium">Enroll a member</h3>
        {!pending ? (
          <>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste their enrollment code (RELAY-ENROLL:…)"
              rows={3}
              className="px-3 py-2 rounded bg-[var(--bg)] border border-[var(--border)] text-xs font-mono"
            />
            <button type="button" disabled={busy || !code.trim()} className={primary} onClick={checkCode}>
              Check code
            </button>
          </>
        ) : (
          <>
            <p className="text-sm">
              <span className="font-medium">{pending.request.name || "(no name)"}</span>
            </p>
            <p className="text-xs text-[var(--muted)]">
              Check this fingerprint matches the one on their screen: <Fingerprint keyB64={pending.request.ecdh} />
            </p>
            <label className="text-xs text-[var(--muted)] flex flex-col gap-1">
              Re-enrolling someone who lost their device? Pick their old key to replace it:
              <select
                value={replaces}
                onChange={(e) => setReplaces(e.target.value)}
                className="px-2 py-1.5 rounded bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text)]"
              >
                <option value="">New member</option>
                {directory.members
                  .filter((m) => m.keyHash !== identity.keyHash)
                  .map((m) => (
                    <option key={m.keyHash} value={m.keyHash}>
                      Replaces {getDisplayName(m.keyHash) || m.keyHash.slice(0, 8)}
                    </option>
                  ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button type="button" disabled={busy} className={button} onClick={() => setPending(null)}>
                Cancel
              </button>
              <button type="button" disabled={busy} className={primary} onClick={confirmEnroll}>
                {busy ? "Publishing…" : "Enroll"}
              </button>
            </div>
          </>
        )}
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
