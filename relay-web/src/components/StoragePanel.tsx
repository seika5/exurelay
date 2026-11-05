"use client";

import { useState } from "react";
import type { Conversation, StorageStats } from "@/lib/useMessages";
import { MAX_RETENTION_DAYS } from "@/lib/messageCache";
import { InfoTip, SectionTitle } from "@/components/InfoTip";
import { confirmDialog } from "@/components/Modal";
import { btn, btnDanger, field } from "@/components/ui";

export type StorageControls = {
  stats: StorageStats;
  retentionDays: number;
  setRetentionDays: (days: number) => void;
  clearFiles: () => Promise<void>;
  clearConversation: (conv: Conversation) => Promise<void>;
  clearAll: () => Promise<void>;
  resync: () => Promise<void>;
};

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Settings → Storage: what this device keeps, for how long, and ways to clear it (DESIGN.md §5). */
export function StoragePanel({
  storage,
  conversations,
}: {
  storage: StorageControls;
  conversations: { conv: Conversation; label: string }[];
}) {
  const { stats } = storage;
  const [days, setDays] = useState(String(storage.retentionDays));
  const [convIndex, setConvIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const act = async (confirmText: string, ok: string, fn: () => Promise<void>, done: string, danger = true) => {
    if (!(await confirmDialog(confirmText, { ok, danger }))) return;
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <section className="flex flex-col gap-1">
        <SectionTitle tip="Messages are saved here encrypted, so the app only downloads what's new.">On this device</SectionTitle>
        <div className="text-xs">
          Messages: {stats.messages} ({fmt(stats.messageBytes)}) · Files: {stats.files} ({fmt(stats.fileBytes)})
        </div>
      </section>

      <section className="flex flex-col gap-1">
        <SectionTitle tip="The server deletes messages after 3 to 4 days. Counting from then means the time a message disappears here doesn't show when it was sent. Default 7.">
          Keep messages for
        </SectionTitle>
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_RETENTION_DAYS}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            onBlur={() => {
              storage.setRetentionDays(Number(days) || storage.retentionDays);
              setDays(String(Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.round(Number(days) || storage.retentionDays)))));
            }}
            className={`${field} w-20`}
          />
          <span>days after the server deletes them</span>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>Clear</SectionTitle>
        {conversations.length > 0 && (
          <div className="flex items-stretch gap-2">
            <select
              value={convIndex}
              onChange={(e) => setConvIndex(Number(e.target.value))}
              aria-label="Conversation"
              className={`${field} flex-1 min-w-0 sm:flex-none sm:max-w-[14rem]`}
            >
              {conversations.map((c, i) => (
                <option key={i} value={i}>
                  {c.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              className={`${btnDanger} shrink-0`}
              onClick={() => {
                const c = conversations[Math.min(convIndex, conversations.length - 1)];
                act(`Clear "${c.label}" from this device?`, "Clear", () => storage.clearConversation(c.conv), "Conversation cleared.");
              }}
            >
              Clear conversation
            </button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {stats.files > 0 && (
            <button
              type="button"
              disabled={busy}
              className={btnDanger}
              onClick={() => act("Remove all files from this device? The messages stay.", "Remove", storage.clearFiles, "Files removed.")}
            >
              Remove files ({fmt(stats.fileBytes)})
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            className={btnDanger}
            onClick={() => act("Clear every message from this device? Others keep their copies.", "Clear", storage.clearAll, "All messages cleared.")}
          >
            Clear all messages
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            className={btn}
            onClick={() =>
              act(
                "Clear this device and download what the server still has?",
                "Download again",
                storage.resync,
                "Downloaded again from the server.",
                false
              )
            }
          >
            Download again
          </button>
          <InfoTip>Clears this device, then downloads what the server still has (the last 3 to 4 days).</InfoTip>
        </div>
        {message && <p className="text-xs text-[var(--muted)]">{message}</p>}
      </section>
    </div>
  );
}
