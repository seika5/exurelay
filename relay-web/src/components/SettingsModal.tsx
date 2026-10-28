"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { MembersAdmin } from "@/components/MembersAdmin";
import { fingerprint } from "@/lib/signed";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { identity, isAdmin, directory, directoryError, setDisplayName, saveIdentityBinary } = useIdentity();
  const [name, setName] = useState(identity?.myName ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fp, setFp] = useState("");

  useEffect(() => {
    if (identity) fingerprint(identity.publicKeyBase64).then(setFp);
  }, [identity]);

  if (!identity) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-30 p-4">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4 w-full max-w-md max-h-[90vh] overflow-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Settings</h2>
          <button type="button" onClick={onClose} className="text-sm text-[var(--accent)]">
            Done
          </button>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Your name</h3>
          <p className="text-xs text-[var(--muted)]">Everyone sees this name. You sign it, so only you can change it.</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              maxLength={64}
              onChange={(e) => {
                setName(e.target.value);
                setMessage(null);
              }}
              className="flex-1 px-3 py-2 rounded bg-[var(--bg)] border border-[var(--border)] text-sm"
            />
            <button
              type="button"
              disabled={saving || !name.trim() || name.trim() === identity.myName}
              onClick={async () => {
                setSaving(true);
                try {
                  await setDisplayName(identity.keyHash, name);
                  setMessage("Saved");
                } catch (e) {
                  setMessage(e instanceof Error ? e.message : "Couldn't save");
                } finally {
                  setSaving(false);
                }
              }}
              className="px-3 py-2 rounded bg-[var(--accent)] text-white text-sm disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {message && <p className="text-xs text-[var(--muted)]">{message}</p>}
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Your key fingerprint</h3>
          <code className="text-xs text-[var(--muted)]">{fp}</code>
          {directory && <p className="text-xs text-[var(--muted)]">Member list version {directory.version}</p>}
          {directoryError && <p className="text-xs text-red-500">{directoryError}</p>}
        </section>

        {isAdmin && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Members (admin)</h3>
            <MembersAdmin />
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Identity file</h3>
          <p className="text-xs text-[var(--muted)]">
            Contains your private keys. Anyone with this file can read your messages and act as you.
          </p>
          <button
            type="button"
            onClick={() => saveIdentityBinary().catch(() => {})}
            className="self-start px-3 py-1.5 rounded border border-[var(--border)] text-sm"
          >
            Save identity file
          </button>
        </section>
      </div>
    </div>
  );
}
