"use client";

import { useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { EnrollmentCode } from "@/components/EnrollmentCode";
import { MembersAdmin } from "@/components/MembersAdmin";
import { QrScanner } from "@/components/QrScanner";
import { ServerSwitcher, serverLabel } from "@/components/ServerSwitcher";

const screen = "min-h-screen flex flex-col items-center justify-center p-6 gap-4 bg-[var(--bg)] text-[var(--text)]";
const safeTop = { paddingTop: "max(1.5rem, env(safe-area-inset-top, 0px))" };

/** Joined a server with no identity for it yet: generate keys for it. Nothing leaves the device until the admin enrolls you. */
export function CreateIdentity() {
  const { createIdentity, error, server, servers, leaveServer } = useIdentity();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <main className={screen} style={safeTop}>
      <h1 className="text-xl font-semibold">Your identity on {server ? serverLabel(server.url) : "this server"}</h1>
      <p className="text-sm text-[var(--muted)] text-center max-w-sm">
        Each server gets its own identity, so servers can&apos;t tell that you&apos;re the same person. Your keys are made on
        this device and never leave it. Then meet the admin in person to get enrolled.
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
      <ServerSwitcher />
      <button type="button" onClick={() => leaveServer().catch(() => {})} className="text-xs text-[var(--muted)] underline">
        {servers.length > 1 ? "Leave this server" : "Use a different server"}
      </button>
    </main>
  );
}

/**
 * Identity exists but no server is chosen: join with the admin's join code (scan, paste, or open their link),
 * or, for the first admin, set up a new server.
 */
export function JoinServer({ onClose }: { onClose?: () => void } = {}) {
  const { joinServer, setUpNewServer } = useIdentity();
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [newServer, setNewServer] = useState(false);
  const [url, setUrl] = useState(process.env.NEXT_PUBLIC_API_URL ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tryJoin = (text: string) => {
    setError(null);
    try {
      joinServer(text);
      onClose?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That join code didn't work.");
    }
  };

  return (
    <main className={screen} style={safeTop}>
      <h1 className="text-xl font-semibold">{onClose ? "Join another server" : "Join a server"}</h1>
      {!newServer ? (
        <>
          <p className="text-sm text-[var(--muted)] text-center max-w-sm">
            Ask your admin for the server&apos;s join code. It tells this app where the server is and which admin keys to
            trust, so get it from them directly (in person, or a channel you already trust).
          </p>
          {scanning ? (
            <QrScanner
              onClose={() => setScanning(false)}
              onResult={(text) => {
                setScanning(false);
                tryJoin(text);
              }}
            />
          ) : (
            <div className="flex flex-col gap-2 w-full max-w-xs">
              <button type="button" onClick={() => setScanning(true)} className="py-2 rounded bg-[var(--accent)] text-white text-sm">
                Scan join code
              </button>
              <textarea
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="…or paste the join code or link"
                rows={3}
                className="px-3 py-2 rounded bg-[var(--surface)] border border-[var(--border)] text-xs font-mono"
              />
              <button
                type="button"
                disabled={!code.trim()}
                onClick={() => tryJoin(code)}
                className="py-2 rounded border border-[var(--border)] text-sm disabled:opacity-50"
              >
                Join
              </button>
            </div>
          )}
          {error && <p className="text-sm text-red-500 text-center max-w-sm">{error}</p>}
          <button type="button" onClick={() => setNewServer(true)} className="text-xs text-[var(--muted)] underline">
            I&apos;m setting up a new server
          </button>
          {onClose && (
            <button type="button" onClick={onClose} className="text-xs text-[var(--muted)] underline">
              Cancel
            </button>
          )}
        </>
      ) : (
        <form
          className="flex flex-col gap-2 w-full max-w-xs"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setBusy(true);
            try {
              await setUpNewServer(url, name);
              onClose?.();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Invalid address");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-[var(--muted)]">
            Enter your server&apos;s address and your name there. This creates your identity for that server; you&apos;ll
            be its first admin, and the next screen shows the key to put in the server&apos;s settings.
          </p>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://relay.example.com"
            className="px-3 py-2 rounded bg-[var(--surface)] border border-[var(--border)] text-sm"
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your display name"
            maxLength={64}
            className="px-3 py-2 rounded bg-[var(--surface)] border border-[var(--border)] text-sm"
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" disabled={busy || !url.trim() || !name.trim()} className="py-2 rounded bg-[var(--accent)] text-white text-sm disabled:opacity-50">
            {busy ? "Creating…" : "Continue"}
          </button>
          <button type="button" onClick={() => setNewServer(false)} className="text-xs text-[var(--muted)] underline">
            Back
          </button>
        </form>
      )}
    </main>
  );
}

function SigningKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex gap-2 items-start w-full">
      <code className="flex-1 break-all bg-[var(--surface)] rounded p-2 text-xs">{value}</code>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => {});
          setCopied(true);
        }}
        className="px-2 py-1 rounded border border-[var(--border)] text-xs"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Identity exists but isn't in the member directory yet: show the enrollment code for the admin. */
export function NotEnrolled() {
  const { identity, directory, directoryError, isAdmin, error, server, servers, leaveServer } = useIdentity();
  if (!identity) return null;

  // Not a member here yet, but maybe of another joined server: let them go back to it.
  const leave = (
    <div className="flex flex-col items-center gap-2">
      <ServerSwitcher />
      <button
        type="button"
        onClick={() => {
          if (window.confirm("Leave this server? Your identity for it is deleted, so an enrollment code you already sent won't work.")) {
            leaveServer().catch(() => {});
          }
        }}
        className="text-xs text-[var(--muted)] underline"
      >
        {servers.length > 1 ? "Leave this server" : "Use a different server"}
      </button>
    </div>
  );

  // First admin, before any directory exists: publish one containing just yourself.
  if (isAdmin && !directory) {
    return (
      <main className={screen} style={safeTop}>
        <h1 className="text-xl font-semibold">Set up Relay</h1>
        <p className="text-sm text-[var(--muted)] text-center max-w-sm">
          1. Put this signing key in <code>ADMIN_SIGNING_KEYS</code> in the server&apos;s <code>.env</code> and restart
          it. It only authorizes the first member list.
        </p>
        <div className="w-full max-w-md">
          <SigningKey value={identity.signingPublicKeyBase64} />
        </div>
        <p className="text-sm text-[var(--muted)] text-center max-w-sm">
          2. Create the member list to enroll yourself. Then share the join code and enroll everyone else from Settings
          → Admin.
        </p>
        <div className="w-full max-w-md">
          <MembersAdmin />
        </div>
        {(directoryError || error) && (
          <p className="text-sm text-red-500 text-center max-w-sm whitespace-pre-wrap">{directoryError || error}</p>
        )}
        <p className="text-xs text-[var(--muted)]">Server: {server?.url}</p>
        {leave}
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
      <p className="text-xs text-[var(--muted)]">Server: {server?.url}</p>
      {leave}
    </main>
  );
}
