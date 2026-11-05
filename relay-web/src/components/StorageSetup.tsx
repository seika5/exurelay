"use client";

import { useState } from "react";
import type { StorageChoice } from "@/context/IdentityContext";
import { MIN_PASSPHRASE_LENGTH } from "@/lib/identityFile";
import { folderStorageSupported, pickFolder } from "@/lib/keystore";

const field = "px-3 py-2 rounded bg-[var(--bg)] border border-[var(--border)] text-sm";

/**
 * Shown when creating an identity: where it will live, and what that means. Desktop Chrome/Edge keep it as a
 * passphrase-encrypted file in a folder the user picks; other browsers and phones keep it in the app's storage.
 */
export function StorageSetup({
  onConfirm,
  onCancel,
}: {
  onConfirm: (storage: StorageChoice) => Promise<void>;
  onCancel: () => void;
}) {
  const folderMode = folderStorageSupported();
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = passphrase.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = understood && (!folderMode || (dir && !tooShort && confirm === passphrase));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(folderMode && dir ? { kind: "folder", dir, passphrase } : { kind: "app" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create your identity.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 p-4">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 w-full max-w-md max-h-[90vh] overflow-auto flex flex-col gap-3 text-sm">
        <h2 className="font-semibold text-base">{folderMode ? "Save your identity to a folder" : "Your identity stays in this app"}</h2>

        {folderMode ? (
          <ul className="list-disc pl-5 flex flex-col gap-1.5 text-[var(--muted)]">
            <li>Your keys go in a file in a folder you choose, encrypted with a passphrase. Exurelay asks for the passphrase each time it opens.</li>
            <li>Anyone with the file <em>and</em> the passphrase can read your messages here and act as you. Use a passphrase you don&apos;t use anywhere else.</li>
            <li className="text-amber-300">
              Forget the passphrase or lose the file and there&apos;s no recovery: the admin has to enroll you again. Keep a copy somewhere safe, like a USB stick.
            </li>
            <li>Folders that sync to the cloud (iCloud Desktop &amp; Documents, Dropbox, OneDrive, Google Drive) will upload the encrypted file. Pick a local folder unless you&apos;re OK with that.</li>
            <li>Don&apos;t put it in a shared folder or a git repository.</li>
          </ul>
        ) : (
          <ul className="list-disc pl-5 flex flex-col gap-1.5 text-[var(--muted)]">
            <li>Your keys are made on this device and kept only in this app. They can&apos;t be exported or backed up.</li>
            <li className="text-amber-300">
              Clearing this site&apos;s data, deleting the app, or switching browsers loses them, and the admin has to enroll you again.
            </li>
            <li>On a phone, install Exurelay to the Home Screen first and create your identity there: the browser tab and the installed app keep separate storage.</li>
          </ul>
        )}

        {folderMode && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  try {
                    setDir(await pickFolder());
                  } catch (e) {
                    if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : "Couldn't open that folder.");
                  }
                }}
                className="px-3 py-1.5 rounded border border-[var(--border)]"
              >
                {dir ? "Change folder…" : "Choose folder…"}
              </button>
              {dir && <span className="text-[var(--muted)] truncate">📁 {dir.name}</span>}
            </div>
            <input
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={`Passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters)`}
              className={field}
            />
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Passphrase again"
              className={field}
            />
            {mismatch && <p className="text-xs text-red-500">The passphrases don&apos;t match.</p>}
          </div>
        )}

        <label className="flex items-start gap-2">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-1" />
          <span>I understand there&apos;s no way to recover my identity if I lose it{folderMode ? " or forget the passphrase" : ""}.</span>
        </label>

        {error && <p className="text-red-500">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} disabled={busy} className="px-3 py-1.5 rounded border border-[var(--border)]">
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={submit}
            className="px-3 py-1.5 rounded bg-[var(--accent)] text-on-accent disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create identity"}
          </button>
        </div>
      </div>
    </div>
  );
}
