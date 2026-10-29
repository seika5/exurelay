"use client";

import { useCallback, useEffect, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { QrScanner } from "@/components/QrScanner";
import { getAdminLabels, setAdminLabel } from "@/lib/api";
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
 * members, choose admins, and keep private labels. Every membership change is a new directory version signed on
 * this device; the server can't make these changes itself. Labels live on the server and only admins see them.
 */
export function MembersAdmin() {
  const { identity, directory, isAdmin, publishSignedDirectory, getDisplayName, memberDevices } = useIdentity();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [replaces, setReplaces] = useState("");
  const [label, setLabel] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLabels = useCallback(() => {
    getAdminLabels().then(setLabels, () => {});
  }, []);
  useEffect(() => {
    if (directory && isAdmin) loadLabels();
  }, [directory, isAdmin, loadLabels]);

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
      setLabel("");
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
      const newLabel = label.trim() || (replaces ? labels[replaces] : "");
      if (newLabel) await setAdminLabel(member.keyHash, newLabel).catch(() => {});
      loadLabels();
      setPending(null);
      setCode("");
    });

  const editLabel = (m: DirectoryMember) => {
    const next = window.prompt("Label (only admins see this)", labels[m.keyHash] ?? "");
    if (next === null) return;
    run(async () => {
      await setAdminLabel(m.keyHash, next);
      loadLabels();
    });
  };

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
                {labels[m.keyHash] && <span className="text-[var(--muted)]"> · {labels[m.keyHash]}</span>}
                {m.keyHash === identity.keyHash && <span className="text-[var(--muted)]"> (you)</span>}
                {adminOf(m) && <span className="ml-1 text-xs text-[var(--accent)]">admin</span>}
              </div>
              <div className="flex gap-2 items-center">
                <Fingerprint keyB64={m.ecdh} />
                <span className="text-xs text-[var(--muted)]">{new Date(m.enrolledAt).toLocaleDateString()}</span>
              </div>
            </div>
            <button type="button" disabled={busy} className={button} onClick={() => editLabel(m)}>
              Label
            </button>
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
              Label (optional, only admins see it)
              <input
                type="text"
                value={label}
                maxLength={64}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Sam's work phone"
                className="px-2 py-1.5 rounded bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text)]"
              />
            </label>
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
