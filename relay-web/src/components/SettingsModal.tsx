"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIdentity } from "@/context/IdentityContext";
import { EnrollMember, MembersAdmin } from "@/components/MembersAdmin";
import { BlobSettingsPanel, JoinCodePanel, ServerStatusPanel } from "@/components/AdminPanels";
import { fingerprint } from "@/lib/signed";
import { StoragePanel, type StorageControls } from "@/components/StoragePanel";
import { DevicesPanel } from "@/components/DevicesPanel";
import { PluginsPanel } from "@/components/PluginsPanel";
import { BuildInfo, NotificationsSection } from "@/components/GeneralExtras";
import { Collapsible, InfoTip, SectionTitle } from "@/components/InfoTip";
import { Icon } from "@/components/icons";
import { confirmDialog, Modal } from "@/components/Modal";
import { btnDanger, btnPrimary, field } from "@/components/ui";
import type { Conversation } from "@/lib/useMessages";
import { ApiError } from "@/lib/api";

type Tab = "general" | "devices" | "storage" | "plugins" | "admin";

const TAB_LABELS: Record<Tab, string> = { general: "General", devices: "Devices", storage: "Storage", plugins: "Plugins", admin: "Admin" };

/** A numbered step heading inside a settings section. */
function Step({ children, tip }: { children: React.ReactNode; tip: string }) {
  return (
    <h4 className="text-xs font-medium text-[var(--muted)] flex items-center gap-1.5">
      {children}
      <InfoTip>{tip}</InfoTip>
    </h4>
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
  // A stable close handler: Modal re-focuses its card whenever onClose changes, which would pull focus out of a field
  // each time the parent re-renders.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);

  useEffect(() => {
    if (identity) fingerprint(identity.publicKeyBase64).then(setFp);
  }, [identity]);

  if (!identity) return null;

  return (
    <Modal title="Settings" onClose={close}>
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
            className={`flex items-center justify-center gap-1.5 px-2 py-1.5 touch:min-h-10 rounded whitespace-nowrap ${tab === t ? "flex-[2.2] bg-[var(--accent)] text-on-accent" : "flex-1 border border-[var(--border)]"}`}
          >
            <Icon name={t} />
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
        <div className="flex flex-col gap-2">
          <Collapsible title={directory ? `Members (${directory.members.length})` : "Members"} defaultOpen={!directory}>
            <MembersAdmin />
          </Collapsible>
          {directory && (
            <Collapsible title="Add a member">
              <div className="flex flex-col gap-2">
                <Step tip="It opens Exurelay on this server for them. It isn't secret, but send it to them directly.">1. Send them the join link</Step>
                <JoinCodePanel />
              </div>
              <div className="flex flex-col gap-2 pt-1">
                <Step tip="Once they've joined, their app shows a code. Scan it or paste it here, then check the safety code matches theirs.">
                  2. Scan their code
                </Step>
                <EnrollMember />
              </div>
            </Collapsible>
          )}
          <Collapsible title="Server details">
            <section className="flex flex-col gap-2">
              <SectionTitle tip="Every message, file and call note is padded to one size, so the server can't tell them apart. Every member downloads everything, so a bigger size uses more data. Decoys hide how big a send is.">
                Message padding
              </SectionTitle>
              <BlobSettingsPanel />
            </section>
            <section className="flex flex-col gap-2 pt-2">
              <SectionTitle>Server status</SectionTitle>
              <ServerStatusPanel />
            </section>
          </Collapsible>
        </div>
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
                className={`${field} flex-1 min-w-0`}
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
                className={btnPrimary}
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
          </section>

          <NotificationsSection />

          <div className="flex flex-col gap-1">
              <button
                type="button"
                disabled={leaving}
                onClick={async () => {
                  const ok = await confirmDialog("Leave this server? Your identity for it is deleted. Coming back needs a new join link and the admin's approval.", {
                    ok: "Leave",
                    danger: true,
                  });
                  if (!ok) return;
                  setLeaving(true);
                  setLeaveError(null);
                  try {
                    await leaveServer();
                    onClose();
                  } catch (e) {
                    // The server answered and said no (e.g. the last admin): leaving anyway would strand it.
                    if (e instanceof ApiError && e.status < 500) {
                      setLeaveError(e.message);
                    } else if (
                      await confirmDialog("Can't reach the server. Leave on this device only? You stay listed until an admin removes you.", {
                        ok: "Leave",
                        danger: true,
                      })
                    ) {
                      await leaveServer({ force: true });
                      onClose();
                    }
                  } finally {
                    setLeaving(false);
                  }
                }}
                className={`${btnDanger} self-start`}
              >
                {leaving ? "Leaving…" : "Leave server"}
              </button>
              {leaveError && <p className="text-xs text-red-500">{leaveError}</p>}
          </div>

          {/* Pushed to the bottom of the screen when everything fits. */}
          <div className="mt-auto border-t border-[var(--border)] pt-3 flex flex-col gap-1 text-xs text-[var(--muted)]">
            <p className="flex items-center gap-1.5 flex-wrap">
              Your safety code <code className="whitespace-nowrap">{fp}</code>
              <InfoTip>Others see this code for you. If theirs matches, no one swapped your keys.</InfoTip>
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
    </Modal>
  );
}
