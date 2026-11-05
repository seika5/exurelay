"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { checkNewServer, normalizeServerUrl } from "@/lib/server";
import { EnrollmentCode } from "@/components/EnrollmentCode";
import { MembersAdmin } from "@/components/MembersAdmin";
import { QrScanner } from "@/components/QrScanner";
import { ServerSwitcher, serverLabel } from "@/components/ServerSwitcher";
import { StorageSetup } from "@/components/StorageSetup";
import { WrongPassphraseError } from "@/lib/identityFile";
import { folderStorageSupported, pickFolder } from "@/lib/keystore";
import { confirmDialog } from "@/components/Modal";
import { InfoTip } from "@/components/InfoTip";
import { Icon } from "@/components/icons";
import { btn, btnPrimary, btnSmall, field } from "@/components/ui";

const screen = "min-h-screen flex flex-col items-center justify-center p-6 gap-4 bg-[var(--bg)] text-[var(--text)]";
const safeTop = { paddingTop: "max(1.5rem, env(safe-area-inset-top, 0px))" };
/** The column of secondary buttons under a screen's main form. */
const actions = "flex flex-col gap-2 w-full max-w-xs";

/**
 * Joined a server with no identity for it yet: generate keys for it. Nothing leaves the device until the admin enrolls
 * you, or until one of your other devices links this one ("Add to my account": no name, since a linked device takes
 * the member's name from its other devices).
 */
export function CreateIdentity() {
  const { createIdentity, openIdentityFolder, error, server, servers, leaveServer } = useIdentity();
  const [name, setName] = useState("");
  const [linking, setLinking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const label = server ? serverLabel(server.url) : "this server";

  return (
    <main className={screen} style={safeTop}>
      {linking ? (
        <>
          <h1 className="text-xl font-semibold text-center">Add this device to your account</h1>
          <p className="text-sm text-[var(--muted)] text-center max-w-sm">
            This device makes its own keys. Next, your other device adds it.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold text-center">Your name on {label}</h1>
          <p className="text-sm text-[var(--muted)] text-center max-w-sm">
            Your keys are made on this device and never leave it. Next, the admin enrolls you.{" "}
            <InfoTip>Each server gets its own keys, so servers can&apos;t tell you&apos;re the same person.</InfoTip>
          </p>
        </>
      )}
      {error && <p className="text-sm text-red-500 text-center max-w-sm whitespace-pre-wrap">{error}</p>}
      {choosing && (
        <StorageSetup
          linking={linking}
          onCancel={() => setChoosing(false)}
          onConfirm={(storage) => createIdentity(linking ? "" : name, storage)}
        />
      )}
      <form
        className="flex flex-col gap-2 w-full max-w-xs"
        onSubmit={(e) => {
          e.preventDefault();
          setLocalError(null);
          setChoosing(true);
        }}
      >
        {!linking && (
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your display name"
            maxLength={64}
            className={field}
          />
        )}
        {localError && <p className="text-sm text-red-500">{localError}</p>}
        <button type="submit" disabled={!linking && !name.trim()} className={btnPrimary}>
          Continue
        </button>
      </form>
      <div className={actions}>
        {linking ? (
          <button type="button" onClick={() => setLinking(false)} className={btn}>
            <Icon name="onbBack" />
            Back
          </button>
        ) : (
          <button type="button" onClick={() => setLinking(true)} className={btn}>
            Add to my account instead
          </button>
        )}
        {folderStorageSupported() && (
          <button
            type="button"
            onClick={async () => {
              setLocalError(null);
              try {
                await openIdentityFolder(await pickFolder());
              } catch (e) {
                if (!(e instanceof DOMException && e.name === "AbortError")) setLocalError(e instanceof Error ? e.message : "Couldn't open that folder.");
              }
            }}
            className={btn}
          >
            <Icon name="onbFolder" />
            Open an identity file
          </button>
        )}
        <button type="button" onClick={() => leaveServer().catch(() => {})} className={btn}>
          {servers.length > 1 ? "Leave this server" : "Use a different server"}
        </button>
        <ServerSwitcher className="self-center" />
      </div>
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
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Checking the new server, or waiting for it to finish installing (checked again every 10 seconds). */
  const [waiting, setWaiting] = useState<"checking" | "starting" | null>(null);

  const checkServer = async () => {
    const status = await checkNewServer(url);
    if (status === "starting") return setWaiting("starting");
    setWaiting(null);
    if (status === "claimed") setError("This server already has a member list. Ask its admin for a join code.");
    else setChoosing(true);
  };

  useEffect(() => {
    if (waiting !== "starting") return;
    const t = setInterval(checkServer, 10_000);
    return () => clearInterval(t);
    // checkServer only reads url, which is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, url]);

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
            Get the join code from your admin, in person or over a chat you trust.{" "}
            <InfoTip>It tells this app where the server is and which admin keys to trust.</InfoTip>
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
              <button type="button" onClick={() => setScanning(true)} className={btnPrimary}>
                <Icon name="onbScan" />
                Scan join code
              </button>
              <textarea
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="…or paste the join code or link"
                rows={3}
                className={`${field} text-xs font-mono`}
              />
              <button
                type="button"
                disabled={!code.trim()}
                onClick={() => tryJoin(code)}
                className={btn}
              >
                Join
              </button>
            </div>
          )}
          {error && <p className="text-sm text-red-500 text-center max-w-sm">{error}</p>}
          <div className={actions}>
            <button type="button" onClick={() => setNewServer(true)} className={btn}>
              I&apos;m setting up a new server
            </button>
            {onClose && (
              <button type="button" onClick={onClose} className={btn}>
                Cancel
              </button>
            )}
          </div>
        </>
      ) : (
        <form
          className="flex flex-col gap-2 w-full max-w-xs"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            try {
              normalizeServerUrl(url);
            } catch (err) {
              return setError(err instanceof Error ? err.message : "Invalid address");
            }
            setWaiting("checking");
            void checkServer();
          }}
        >
          <p className="text-sm text-[var(--muted)]">
            You&apos;ll be the first admin. Have your setup code ready.{" "}
            <InfoTip>The one you chose when creating the server, or the one it showed when it was installed.</InfoTip>
          </p>
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setWaiting(null);
            }}
            placeholder="https://relay.example.com"
            className={field}
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your display name"
            maxLength={64}
            className={field}
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          {waiting === "starting" && (
            <p className="text-sm text-[var(--muted)]" role="status">
              Not answering yet. A new server takes about 5 minutes. Checking every 10 seconds.
            </p>
          )}
          <button
            type="submit"
            disabled={!url.trim() || !name.trim() || waiting !== null}
            className={btnPrimary}
          >
            {waiting === "checking" ? "Checking the server…" : waiting === "starting" ? "Waiting for the server…" : "Continue"}
          </button>
          <button type="button" onClick={() => { setWaiting(null); setNewServer(false); }} className={btn}>
            <Icon name="onbBack" />
            Back
          </button>
        </form>
      )}
      {choosing && (
        <StorageSetup
          onCancel={() => setChoosing(false)}
          onConfirm={async (storage) => {
            await setUpNewServer(url, name, storage);
            onClose?.();
          }}
        />
      )}
    </main>
  );
}

/** The active server's identity is a passphrase-encrypted file in a folder: unlock it. */
export function UnlockIdentity() {
  const { lockedFile, unlockIdentity, openIdentityFolder, server, leaveServer } = useIdentity();
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  if (!lockedFile) return null;

  const chooseFolder = async () => {
    setError(null);
    try {
      await openIdentityFolder(await pickFolder());
      setMissing(false);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : "Couldn't open that folder.");
    }
  };

  return (
    <main className={screen} style={safeTop}>
      <h1 className="text-xl font-semibold">Unlock {server ? serverLabel(server.url) : "Exurelay"}</h1>
      <p className="text-sm text-[var(--muted)] text-center max-w-sm">
        Your identity is in <code>{lockedFile.fileName}</code> in the folder &ldquo;{lockedFile.folder}&rdquo;. Enter its passphrase. The
        browser may ask to let Exurelay use that folder.
      </p>
      <form
        className="flex flex-col gap-2 w-full max-w-xs"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await unlockIdentity(passphrase);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Couldn't unlock.";
            setMissing(!(err instanceof WrongPassphraseError) && message.includes("isn't in the folder"));
            setError(message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          type="password"
          autoComplete="current-password"
          autoFocus
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Passphrase"
          className={field}
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button type="submit" disabled={busy || !passphrase} className={btnPrimary}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </form>
      <div className={actions}>
        <button type="button" onClick={chooseFolder} className={missing ? btnPrimary : btn}>
          <Icon name="onbFolder" />
          File moved? Choose its folder
        </button>
        <button
          type="button"
          onClick={async () => {
            const yes = await confirmDialog(
              "Forget this server on this device? The identity file stays and you stay a member. To leave, unlock and use Settings.",
              { ok: "Forget", danger: true }
            );
            if (yes) leaveServer().catch(() => {});
          }}
          className={btn}
        >
          Forget this server here
        </button>
        <ServerSwitcher className="self-center" />
      </div>
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
        className={btnSmall}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Identity exists but isn't in the member directory yet: show the enrollment code for the admin. */
export function NotEnrolled() {
  const { identity, directory, directoryError, isAdmin, error, server, servers, leaveServer, unlinked, startOver } = useIdentity();
  if (!identity) return null;

  // Unlinked from its account: these keys are dead (an unlink is permanent, so it can't be replayed away).
  if (unlinked) {
    return (
      <main className={screen} style={safeTop}>
        <h1 className="text-xl font-semibold">This device was unlinked</h1>
        <p className="text-sm text-[var(--muted)] text-center max-w-sm">
          One of your devices removed this one from your account, so its keys no longer work here. To use this device
          again, start over: it makes new keys, and you link it again from another device (or ask the admin).
        </p>
        <button type="button" onClick={() => startOver().catch(() => {})} className={btnPrimary}>
          Start over
        </button>
        <ServerSwitcher />
      </main>
    );
  }

  // Not a member here yet, but maybe of another joined server: let them go back to it.
  const leave = (
    <div className={actions}>
      <button
        type="button"
        onClick={async () => {
          const yes = await confirmDialog("Leave this server? Your keys for it are deleted, so a code you already sent stops working.", {
            ok: "Leave",
            danger: true,
          });
          if (yes) leaveServer().catch(() => {});
        }}
        className={btn}
      >
        {servers.length > 1 ? "Leave this server" : "Use a different server"}
      </button>
      <ServerSwitcher className="self-center" />
    </div>
  );

  // First admin, before any directory exists: publish one containing just yourself.
  if (isAdmin && !directory) {
    return (
      <main className={screen} style={safeTop}>
        <h1 className="text-xl font-semibold">Set up Exurelay</h1>
        <p className="text-sm text-[var(--muted)] text-center max-w-sm">
          Enter your setup code to create the member list. Then add everyone from Settings, Admin.
        </p>
        <details className="w-full max-w-md text-sm text-[var(--muted)] text-center">
          <summary className={`${btnSmall} list-none [&::-webkit-details-marker]:hidden cursor-pointer text-[var(--text)]`}>
            Set up by hand instead
          </summary>
          <p className="mt-2 text-center">
            Put this signing key in <code>ADMIN_SIGNING_KEYS</code> in the server&apos;s <code>.env</code>, restart it,
            and leave the setup code empty. It only authorizes the first member list.
          </p>
          <div className="mt-2">
            <SigningKey value={identity.signingPublicKeyBase64} />
          </div>
        </details>
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
        {/* No name: made with "Add to my account" on the create screen, to be linked from another device. */}
        {identity.myName ? "Show this to your admin to get enrolled." : "On your other device, open Settings, then Devices, and scan this code."}{" "}
        <InfoTip>This screen moves on by itself once you&apos;re in.</InfoTip>
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
