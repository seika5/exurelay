"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { CodeInput } from "@/components/CodeInput";
import { IconButton } from "@/components/icons";
import { confirmDialog } from "@/components/Modal";
import { btn, btnPrimary, field } from "@/components/ui";
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

function SafetyCode({ keyB64, className = "text-xs text-[var(--muted)]" }: { keyB64: string; className?: string }) {
  const [fp, setFp] = useState("");
  useEffect(() => {
    fingerprint(keyB64).then(setFp);
  }, [keyB64]);
  return <code className={`${className} whitespace-nowrap`}>{fp}</code>;
}

/** Run an async action with a busy flag and an error message. */
function useRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/**
 * Admin-only member list: create the directory, remove members and choose admins. Every membership change is a new
 * directory version signed on this device; the server can't make these changes itself.
 */
export function MembersAdmin() {
  const { identity, directory, isAdmin, publishSignedDirectory, getDisplayName, memberDevices } = useIdentity();
  const { busy, error, run } = useRunner();
  const [setupCode, setSetupCode] = useState("");

  if (!identity || !isAdmin) return null;
  const me = identity.signingPublicKeyBase64;

  // The first member list. A server installed by deploy/install.sh takes its one-time setup code instead of having
  // this admin's signing key in ADMIN_SIGNING_KEYS; a hand-configured one needs no code.
  if (!directory) {
    return (
      <div className="flex flex-col gap-2">
        <input
          type="text"
          value={setupCode}
          onChange={(e) => setSetupCode(e.target.value)}
          placeholder="Setup code"
          autoComplete="off"
          spellCheck={false}
          className={`${field} font-mono`}
        />
        <button
          type="button"
          disabled={busy}
          className={`${btnPrimary} self-start`}
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
  const nameOf = (m: DirectoryMember) => getDisplayName(m.keyHash) || m.keyHash.slice(0, 8);

  const toggleAdmin = async (m: DirectoryMember) => {
    const isAdminNow = adminOf(m);
    const question = isAdminNow
      ? `Stop ${nameOf(m)} being an admin?`
      : `Make ${nameOf(m)} an admin? Admins can enroll and remove anyone, including you.`;
    if (!(await confirmDialog(question, { ok: isAdminNow ? "Remove admin" : "Make admin" }))) return;
    const theirs = memberSigs(m, memberDevices);
    const next = isAdminNow ? admins.filter((a) => !theirs.includes(a)) : [...admins, m.sig];
    run(() => publishSignedDirectory(directoryWithAdmins(directory, me, next, Date.now(), memberDevices)));
  };

  const remove = async (m: DirectoryMember) => {
    if (!(await confirmDialog(`Remove ${nameOf(m)}? They lose access to this server.`, { ok: "Remove", danger: true }))) return;
    run(() => publishSignedDirectory(directoryWithoutMember(directory, me, m.keyHash, Date.now(), memberDevices)));
  };

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {directory.members.map((m) => {
          const isMe = m.keyHash === identity.keyHash;
          const admin = adminOf(m);
          return (
            <li key={m.keyHash} className="flex items-center gap-2 py-1">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
                  <span className="break-words min-w-0">{nameOf(m)}</span>
                  {isMe && <span className="text-[var(--muted)] whitespace-nowrap">(you)</span>}
                  {admin && <span className="text-xs text-[var(--accent)] whitespace-nowrap">admin</span>}
                </div>
                <div className="flex flex-wrap gap-x-2 items-center">
                  <SafetyCode keyB64={m.ecdh} />
                  <span className="text-xs text-[var(--muted)] whitespace-nowrap">{new Date(m.enrolledAt).toLocaleDateString()}</span>
                </div>
              </div>
              {!isMe && (
                <>
                  <IconButton
                    icon={admin ? "removeAdmin" : "makeAdmin"}
                    label={admin ? "Remove admin" : "Make admin"}
                    disabled={busy}
                    onClick={() => toggleAdmin(m)}
                  />
                  <IconButton icon="removePerson" label="Remove" danger disabled={busy} onClick={() => remove(m)} />
                </>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}

type Pending = { request: EnrollmentRequest; keyHash: string };

/** Admin-only: enroll a new member from the enrollment code their app shows (scanned or pasted). */
export function EnrollMember() {
  const { identity, directory, isAdmin, publishSignedDirectory, getDisplayName } = useIdentity();
  const { busy, error, setError, run } = useRunner();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [replaces, setReplaces] = useState("");

  if (!identity || !isAdmin || !directory) return null;
  const me = identity.signingPublicKeyBase64;

  const checkCode = (text: string) =>
    run(async () => {
      const result = await readEnrollmentCode(text);
      if (!result.ok) throw new Error(result.error);
      if (directory.members.some((m) => m.keyHash === result.keyHash)) throw new Error("That key is already enrolled.");
      setCode(text);
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

  return (
    <div className="flex flex-col gap-2">
      {!pending ? (
        <CodeInput
          value={code}
          onChange={(t) => {
            setCode(t);
            setError(null);
          }}
          onCheck={checkCode}
          scanLabel="Scan their code"
          disabled={busy}
        />
      ) : (
        <>
          <p className="text-sm font-medium break-words">{pending.request.name || "(no name)"}</p>
          <p className="text-xs text-[var(--muted)]">
            Check the safety code matches theirs: <SafetyCode keyB64={pending.request.ecdh} className="text-xs font-semibold text-[var(--text)]" />
          </p>
          <label className="text-xs text-[var(--muted)] flex flex-col gap-1">
            Replacing a lost device? Pick their old key:
            <select value={replaces} onChange={(e) => setReplaces(e.target.value)} className={`${field} text-[var(--text)]`}>
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
            <button
              type="button"
              disabled={busy}
              className={btn}
              onClick={() => {
                setPending(null);
                setCode("");
              }}
            >
              Cancel
            </button>
            <button type="button" disabled={busy} className={btnPrimary} onClick={confirmEnroll}>
              {busy ? "Publishing…" : "Enroll"}
            </button>
          </div>
        </>
      )}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
