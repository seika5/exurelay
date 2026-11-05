"use client";

import { useCallback, useRef, useState } from "react";
import type { StorageChoice } from "@/context/IdentityContext";
import { MIN_PASSPHRASE_LENGTH } from "@/lib/identityFile";
import { folderStorageSupported, pickFolder } from "@/lib/keystore";
import { Modal } from "@/components/Modal";
import { InfoTip } from "@/components/InfoTip";
import { Icon } from "@/components/icons";
import { btn, btnPrimary, field } from "@/components/ui";

/**
 * Shown when creating an identity: where it will live, and what that means. Desktop Chrome/Edge keep it as a
 * passphrase-encrypted file in a folder the user picks; other browsers and phones keep it in the app's storage.
 * `linking`: these keys are for a device that will be linked to an existing member, so losing them means linking again.
 */
export function StorageSetup({
  onConfirm,
  onCancel,
  linking = false,
}: {
  onConfirm: (storage: StorageChoice) => Promise<void>;
  onCancel: () => void;
  linking?: boolean;
}) {
  const folderMode = folderStorageSupported();
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal refocuses itself whenever onClose changes, so keep it stable.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const close = useCallback(() => {
    if (!busyRef.current) cancelRef.current();
  }, []);

  const tooShort = passphrase.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = understood && (!folderMode || (dir && !tooShort && confirm === passphrase));
  const again = linking ? "you have to link this device again." : "the admin has to enroll you again.";

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
    <Modal title={folderMode ? "Save your keys to a folder" : "Your keys stay in this app"} onClose={close} closeLabel={null}>
      <div className="flex flex-col gap-3 text-sm">
        {folderMode ? (
          <>
            <p className="text-[var(--muted)]">
              Your keys go in a file in a folder you pick, locked with a passphrase you use nowhere else.{" "}
              <InfoTip>
                Exurelay asks for the passphrase each time it opens. Anyone with the file and the passphrase can act as
                you. Cloud folders (iCloud, Dropbox, OneDrive, Google Drive) upload the encrypted file, so pick a local one
                unless that&apos;s fine. Keep a copy somewhere safe, like a USB stick, but not in a shared folder or a git
                repository.
              </InfoTip>
            </p>
            <p className="text-amber-300">Lose the file or forget the passphrase and {again}</p>
          </>
        ) : (
          <>
            <p className="text-[var(--muted)]">
              Your keys stay in this app and can&apos;t be backed up.{" "}
              <InfoTip>Switching browsers loses them too. Each server gets its own keys.</InfoTip>
            </p>
            <p className="text-amber-300">Delete the app or clear its data and {again}</p>
          </>
        )}

        {folderMode && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 min-w-0">
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
                className={btn}
              >
                <Icon name="onbFolder" />
                {dir ? "Change folder" : "Choose folder"}
              </button>
              {dir && <span className="text-[var(--muted)] truncate">{dir.name}</span>}
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
          <span>I understand my keys can&apos;t be recovered if I lose them{folderMode ? " or forget the passphrase" : ""}.</span>
        </label>

        {error && <p className="text-red-500">{error}</p>}

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} disabled={busy} className={btn}>
            Cancel
          </button>
          <button type="button" disabled={!ready || busy} onClick={submit} className={btnPrimary}>
            {busy ? "Creating…" : "Create identity"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
