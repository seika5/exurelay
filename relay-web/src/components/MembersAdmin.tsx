"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { QrScanner } from "@/components/QrScanner";
import {
  directoryWithAdmins,
  directoryWithMember,
  directoryWithoutMember,
  fingerprint,
  memberSigs,
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
 * Admin-only member management: create the directory, enroll from a scanned or pasted enrollment code, remove
 * members and choose admins. Every membership change is a new directory version signed on this device; the server
 * can't make these changes itself.
 */
export function MembersAdmin() {
  const { identity, directory, isAdmin, publishSignedDirectory, getDisplayName, memberDevices } = useIdentity();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [replaces, setReplaces] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupCode, setSetupCode] = useState("");

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

  // The first member list. A server installed by deploy/install.sh takes its one-time setup code instead of having
  // this admin's signing key in ADMIN_SIGNING_KEYS; a hand-configured one needs no code.
  if (!directory) {
    return (
      <div className="flex flex-col gap-2 items-center">
        <input
          type="text"
          value={setupCode}
          onChange={(e) => setSetupCode(e.target.value)}
          placeholder="Setup code"
          autoComplete="off"
          spellCheck={false}
          className="w-full px-2 py-1.5 rounded bg-[var(--bg)] border border-[var(--border)] text-sm font-mono"
        />
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
                }),
                setupCode
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

  const admins = directory.admins ?? [directory.signer];
  // A member is an admin if their enrolled key or any of their linked devices is on the admin list.
  const adminOf = (m: DirectoryMember) => memberSigs(m, memberDevices).some((k) => admins.includes(k));

  const checkCode = (text = code) =>
    run(async () => {
      const result = await readEnrollmentCode(text);
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

  const toggleAdmin = (m: DirectoryMember) => {
    const isAdminNow = adminOf(m);
    const label = getDisplayName(m.keyHash) || m.keyHash.slice(0, 8);
    const question = isAdminNow
      ? `Stop ${label} being an admin?`
      : `Make ${label} an admin? Admins can enroll and remove anyone, including you.`;
    if (!window.confirm(question)) return;
    const theirs = memberSigs(m, memberDevices);
    const next = isAdminNow ? admins.filter((a) => !theirs.includes(a)) : [...admins, m.sig];
    run(() => publishSignedDirectory(directoryWithAdmins(directory, me, next, Date.now(), memberDevices)));
  };

  const remove = (m: DirectoryMember) => {
    const label = getDisplayName(m.keyHash) || m.keyHash.slice(0, 8);
    if (!window.confirm(`Remove ${label}? They'll no longer be able to use this server.`)) return;
    run(() => publishSignedDirectory(directoryWithoutMember(directory, me, m.keyHash, Date.now(), memberDevices)));
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
                {adminOf(m) && <span className="ml-1 text-xs text-[var(--accent)]">admin</span>}
              </div>
              <div className="flex gap-2 items-center">
                <Fingerprint keyB64={m.ecdh} />
                <span className="text-xs text-[var(--muted)]">{new Date(m.enrolledAt).toLocaleDateString()}</span>
              </div>
            </div>
            {m.keyHash !== identity.keyHash && (
              <>
                <button type="button" disabled={busy} className={button} onClick={() => toggleAdmin(m)}>
                  {adminOf(m) ? "Unadmin" : "Admin"}
                </button>
                <button type="button" disabled={busy} className={button} onClick={() => remove(m)}>
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="border-t border-[var(--border)] pt-3 flex flex-col gap-2">
        <h3 className="text-sm font-medium">Enroll a member</h3>
        {scanning ? (
          <QrScanner
            onClose={() => setScanning(false)}
            onResult={(text) => {
              setScanning(false);
              setCode(text);
              checkCode(text);
            }}
          />
        ) : !pending ? (
          <>
            <button type="button" disabled={busy} className={primary} onClick={() => setScanning(true)}>
              Scan their QR code
            </button>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="…or paste their enrollment code (RELAY-ENROLL:…)"
              rows={3}
              className="px-3 py-2 rounded bg-[var(--bg)] border border-[var(--border)] text-xs font-mono"
            />
            <button type="button" disabled={busy || !code.trim()} className={button} onClick={() => checkCode()}>
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
