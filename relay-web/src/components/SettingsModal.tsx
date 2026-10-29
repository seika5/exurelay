"use client";

import { useEffect, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { MembersAdmin } from "@/components/MembersAdmin";
import { BlobSettingsPanel, JoinCodePanel, ServerStatusPanel } from "@/components/AdminPanels";
import { fingerprint } from "@/lib/signed";
import { StoragePanel, type StorageControls } from "@/components/StoragePanel";
import { DevicesPanel } from "@/components/DevicesPanel";
import { PluginsPanel } from "@/components/PluginsPanel";
import { BuildInfo, NotificationsSection } from "@/components/GeneralExtras";
import type { Conversation } from "@/lib/useMessages";
import { ApiError } from "@/lib/api";

export function SettingsModal({
  onClose,
  storage,
  conversations,
}: {
  onClose: () => void;
  storage: StorageControls;
  conversations: { conv: Conversation; label: string }[];
}) {
  const { identity, isAdmin, directory, directoryError, setDisplayName, server, servers, leaveServer, identityStorage } = useIdentity();
  const [tab, setTab] = useState<"general" | "devices" | "storage" | "plugins" | "admin">("general");
  const [name, setName] = useState(identity?.myName ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fp, setFp] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

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

        <div className="flex flex-wrap gap-1 text-sm">
          {(isAdmin ? (["general", "devices", "storage", "plugins", "admin"] as const) : (["general", "devices", "storage", "plugins"] as const)).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded ${tab === t ? "bg-[var(--accent)] text-white" : "border border-[var(--border)]"}`}
            >
              {t === "general" ? "General" : t === "devices" ? "Devices" : t === "storage" ? "Storage" : t === "plugins" ? "Plugins" : "Admin"}
            </button>
          ))}
        </div>

        {tab === "plugins" ? (
          <PluginsPanel />
        ) : tab === "devices" ? (
          <DevicesPanel />
        ) : tab === "storage" ? (
          <StoragePanel storage={storage} conversations={conversations} />
        ) : tab === "admin" && isAdmin ? (
          <>
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Join code</h3>
              <JoinCodePanel />
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Members</h3>
              <MembersAdmin />
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Message blobs</h3>
              <BlobSettingsPanel />
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Server status</h3>
              <ServerStatusPanel />
            </section>
          </>
        ) : (
          <>

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

        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Server</h3>
          <code className="text-xs text-[var(--muted)] break-all">{server?.url}</code>
          {servers.length > 1 && (
            <p className="text-xs text-[var(--muted)]">
              Joined {servers.length} servers; switch with the menu above your chats. Each has its own identity.
            </p>
          )}
          <button
            type="button"
            disabled={leaving}
            onClick={async () => {
              if (!window.confirm("Leave this server? You're removed as a member right away, and your identity and unspent tokens for it are deleted. To come back you'd need a new join code and the admin's approval.")) return;
              setLeaving(true);
              setLeaveError(null);
              try {
                await leaveServer();
                onClose();
              } catch (e) {
                // The server answered and said no (e.g. the last admin): leaving anyway would strand it.
                if (e instanceof ApiError && e.status < 500) {
                  setLeaveError(e.message);
                } else if (window.confirm("Couldn't reach the server to tell it you're leaving. Leave on this device anyway? You'll stay listed as a member until an admin removes you.")) {
                  await leaveServer({ force: true });
                  onClose();
                }
              } finally {
                setLeaving(false);
              }
            }}
            className="self-start px-3 py-1.5 rounded border border-[var(--border)] text-sm text-red-500 disabled:opacity-50"
          >
            {leaving ? "Leaving…" : "Leave server"}
          </button>
          {leaveError && <p className="text-xs text-red-500">{leaveError}</p>}
        </section>

        <NotificationsSection />

        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Your keys</h3>
          {identityStorage?.kind === "folder" ? (
            <p className="text-xs text-[var(--muted)]">
              In <code>{identityStorage.fileName}</code> in the folder &ldquo;{identityStorage.folder}&rdquo;, encrypted with your passphrase.
              Keep a copy somewhere safe: if you lose the file or forget the passphrase, ask your admin to enroll you again.
            </p>
          ) : (
            <p className="text-xs text-[var(--muted)]">
              Made on this device and kept only in this app. They can&apos;t be exported or backed up. If you lose this
              device or clear the app&apos;s data, ask your admin to enroll you again.
            </p>
          )}
        </section>

        <BuildInfo />
          </>
        )}
      </div>
    </div>
  );
}
