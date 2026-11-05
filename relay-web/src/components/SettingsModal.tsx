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
import { InfoTip, SectionTitle } from "@/components/InfoTip";
import type { Conversation } from "@/lib/useMessages";
import { ApiError } from "@/lib/api";

type Tab = "general" | "devices" | "storage" | "plugins" | "admin";

const TAB_LABELS: Record<Tab, string> = { general: "General", devices: "Devices", storage: "Storage", plugins: "Plugins", admin: "Admin" };

/** Simple stroke icons (24×24), drawn here so the app needs no icon library. */
const TAB_ICONS: Record<Tab, React.ReactNode> = {
  general: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  devices: (
    <>
      <rect x="3" y="4" width="10" height="16" rx="2" />
      <rect x="15" y="9" width="6" height="11" rx="1.5" />
      <path d="M7 17h2" />
    </>
  ),
  storage: (
    <>
      <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
      <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </>
  ),
  plugins: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  admin: <path d="M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6zM9 12l2 2 4-4" />,
};

function TabIcon({ tab }: { tab: Tab }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {TAB_ICONS[tab]}
    </svg>
  );
}

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
  const [tab, setTab] = useState<Tab>("general");
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

        {/* One row at any width: every tab has an icon, and only the selected one also shows its name. */}
        <div className="flex gap-1 text-sm" role="tablist">
          {(isAdmin ? (["general", "devices", "storage", "plugins", "admin"] as const) : (["general", "devices", "storage", "plugins"] as const)).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              aria-label={TAB_LABELS[t]}
              title={TAB_LABELS[t]}
              onClick={() => setTab(t)}
              className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded whitespace-nowrap ${tab === t ? "flex-[2.2] bg-[var(--accent)] text-on-accent" : "flex-1 border border-[var(--border)]"}`}
            >
              <TabIcon tab={t} />
              {tab === t && <span>{TAB_LABELS[t]}</span>}
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
              <SectionTitle tip="It points a new member's app at this server and carries the admin keys their app will trust. It isn't secret, but give it to them directly. You still enroll them after.">
                Join code
              </SectionTitle>
              <JoinCodePanel />
            </section>
            <section className="flex flex-col gap-2">
              <SectionTitle>Members</SectionTitle>
              <MembersAdmin />
            </section>
            <section className="flex flex-col gap-2">
              <SectionTitle tip="Every message, file and call note is stored as blobs of one size, so the server can't tell them apart, and every member downloads every blob. Bigger blobs hide longer messages but use more data. Decoys hide how many blobs a send needs.">
                Message blobs
              </SectionTitle>
              <BlobSettingsPanel />
            </section>
            <section className="flex flex-col gap-2">
              <SectionTitle>Server status</SectionTitle>
              <ServerStatusPanel />
            </section>
          </>
        ) : (
          <>

        <section className="flex flex-col gap-2">
          <SectionTitle tip="Everyone on this server sees it. It's encrypted, so the server can't.">Your name</SectionTitle>
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
              className="px-3 py-2 rounded bg-[var(--accent)] text-on-accent text-sm disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {message && <p className="text-xs text-[var(--muted)]">{message}</p>}
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Server</h3>
          <code className="text-xs text-[var(--muted)] break-all">{server?.url}</code>
          {servers.length > 1 && (
            <p className="text-xs text-[var(--muted)]">
              {servers.length} servers joined. Switch above your chats.
            </p>
          )}
          <button
            type="button"
            disabled={leaving}
            onClick={async () => {
              if (!window.confirm("Leave this server? Your identity for it is deleted. Coming back needs a new join code and the admin's approval.")) return;
              setLeaving(true);
              setLeaveError(null);
              try {
                await leaveServer();
                onClose();
              } catch (e) {
                // The server answered and said no (e.g. the last admin): leaving anyway would strand it.
                if (e instanceof ApiError && e.status < 500) {
                  setLeaveError(e.message);
                } else if (window.confirm("Can't reach the server. Leave on this device only? You'll stay listed until an admin removes you.")) {
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

        <div className="border-t border-[var(--border)] pt-3 flex flex-col gap-1 text-xs text-[var(--muted)]">
          <p>
            Key fingerprint <code>{fp}</code>
            {directory && <> · member list v{directory.version}</>}
          </p>
          {directoryError && <p className="text-red-500">{directoryError}</p>}
          <p className="flex items-center gap-1.5 flex-wrap">
            {identityStorage?.kind === "folder" ? (
              <>
                Keys in <code>{identityStorage.fileName}</code> in &ldquo;{identityStorage.folder}&rdquo;, locked with your passphrase.
              </>
            ) : (
              <>Keys kept in this app only.</>
            )}
            <InfoTip>
              {identityStorage?.kind === "folder"
                ? "Keep a copy of the file somewhere safe. If you lose it or forget the passphrase, the admin has to enroll you again."
                : "They can't be exported or backed up. If you lose this device or clear the app's data, the admin has to enroll you again."}
            </InfoTip>
          </p>
          <BuildInfo />
        </div>
          </>
        )}
      </div>
    </div>
  );
}
