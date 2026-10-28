"use client";

import { useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { EnrollmentCode } from "@/components/EnrollmentCode";
import { MembersAdmin } from "@/components/MembersAdmin";

const screen = "min-h-screen flex flex-col items-center justify-center p-6 gap-4 bg-[var(--bg)] text-[var(--text)]";
const safeTop = { paddingTop: "max(1.5rem, env(safe-area-inset-top, 0px))" };

/** First run: generate this device's keys. Nothing leaves the device until the admin enrolls you. */
export function CreateIdentity() {
  const { createIdentity, error } = useIdentity();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <main className={screen} style={safeTop}>
      <h1 className="text-xl font-semibold">Relay</h1>
      <p className="text-sm text-[var(--muted)] text-center max-w-sm">
        Create your identity. Your keys are made on this device and never leave it. Then meet the admin in person to
        get enrolled.
      </p>
      {error && <p className="text-sm text-red-500 text-center max-w-sm whitespace-pre-wrap">{error}</p>}
      <form
        className="flex flex-col gap-2 w-full max-w-xs"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setLocalError(null);
          try {
            await createIdentity(name);
          } catch (err) {
            setLocalError(err instanceof Error ? err.message : "Couldn't create identity");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your display name"
          maxLength={64}
          className="px-3 py-2 rounded bg-[var(--surface)] border border-[var(--border)] text-sm"
        />
        {localError && <p className="text-sm text-red-500">{localError}</p>}
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="py-2 rounded bg-[var(--accent)] text-white text-sm disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create identity"}
        </button>
      </form>
    </main>
  );
}

/** Identity exists but isn't in the member directory yet: show the enrollment code for the admin. */
export function NotEnrolled() {
  const { identity, directory, directoryError, isAdmin, error } = useIdentity();
  const [copied, setCopied] = useState(false);
  if (!identity) return null;

  // First admin, before any directory exists: publish one containing just yourself.
  if (isAdmin && !directory) {
    return (
      <main className={screen} style={safeTop}>
        <h1 className="text-xl font-semibold">Set up Relay</h1>
        <p className="text-sm text-[var(--muted)] text-center max-w-sm">
          You&apos;re an admin and the server has no member list yet. Create it to enroll yourself, then enroll everyone
          else from Settings → Members.
        </p>
        <div className="w-full max-w-md">
          <MembersAdmin />
        </div>
      </main>
    );
  }

  return (
    <main className={screen} style={safeTop}>
      <h1 className="text-xl font-semibold">Waiting for enrollment</h1>
      <p className="text-sm text-[var(--muted)] text-center max-w-sm">
        Show this code to the admin in person. This screen moves on by itself once they&apos;ve enrolled you.
      </p>
      <EnrollmentCode />
      {(directoryError || error) && (
        <p className="text-sm text-red-500 text-center max-w-sm whitespace-pre-wrap">{directoryError || error}</p>
      )}
      <details className="text-xs text-[var(--muted)] max-w-sm w-full">
        <summary className="cursor-pointer">Setting up a new server?</summary>
        <p className="mt-2">
          If you&apos;re the admin, add this signing key to the server&apos;s <code>ADMIN_SIGNING_KEYS</code> and the web
          app&apos;s <code>NEXT_PUBLIC_ADMIN_SIGNING_KEYS</code>, then rebuild the app.
        </p>
        <div className="mt-2 flex gap-2 items-start">
          <code className="flex-1 break-all bg-[var(--surface)] rounded p-2">{identity.signingPublicKeyBase64}</code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(identity.signingPublicKeyBase64).catch(() => {});
              setCopied(true);
            }}
            className="px-2 py-1 rounded border border-[var(--border)]"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </details>
    </main>
  );
}
