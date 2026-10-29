"use client";

import { useState } from "react";
import type { Conversation, StorageStats } from "@/lib/useMessages";
import { MAX_RETENTION_DAYS } from "@/lib/messageCache";

const button = "px-3 py-1.5 rounded border border-[var(--border)] text-sm disabled:opacity-50";

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

  const act = async (confirmText: string, fn: () => Promise<void>, done: string) => {
    if (!window.confirm(confirmText)) return;
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
        <h3 className="font-medium">On this device</h3>
        <p className="text-xs text-[var(--muted)]">
          Messages are kept here encrypted, so the app only downloads what&apos;s new. Your own messages too.
        </p>
        <div className="text-xs">
          Messages: {stats.messages} ({fmt(stats.messageBytes)}) · Files: {stats.files} ({fmt(stats.fileBytes)})
        </div>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="font-medium">Keep messages for</h3>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={MAX_RETENTION_DAYS}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            onBlur={() => {
              storage.setRetentionDays(Number(days) || storage.retentionDays);
              setDays(String(Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.round(Number(days) || storage.retentionDays)))));
            }}
            className="w-20 px-2 py-1 rounded bg-[var(--bg)] border border-[var(--border)]"
          />
          <span>days after the server deletes them (default 7)</span>
        </div>
        <p className="text-xs text-[var(--muted)]">
          The server keeps messages about 3–4 days. Counting from then (not from when they were sent) means the time
          they disappear here doesn&apos;t reveal when they were sent.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Clear</h3>
        <button
          type="button"
          disabled={busy || stats.files === 0}
          className={`${button} self-start`}
          onClick={() => act("Remove all files from this device? The messages stay, marked as removed.", storage.clearFiles, "Files removed.")}
        >
          Remove files only
        </button>
        {conversations.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={convIndex}
              onChange={(e) => setConvIndex(Number(e.target.value))}
              className="px-2 py-1 rounded bg-[var(--bg)] border border-[var(--border)] max-w-[12rem]"
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
              className={button}
              onClick={() => {
                const c = conversations[Math.min(convIndex, conversations.length - 1)];
                act(`Clear "${c.label}" from this device?`, () => storage.clearConversation(c.conv), "Conversation cleared.");
              }}
            >
              Clear conversation
            </button>
          </div>
        )}
        <button
          type="button"
          disabled={busy}
          className={`${button} self-start`}
          onClick={() =>
            act(
              "Clear every message from this device? Others keep their copies. Messages still on the server won't come back unless you re-sync.",
              storage.clearAll,
              "Everything cleared."
            )
          }
        >
          Clear everything
        </button>
        <button
          type="button"
          disabled={busy}
          className={`${button} self-start`}
          onClick={() =>
            act(
              "Clear this device and download again whatever the server still has (about the last 3–4 days)? Older messages won't come back.",
              storage.resync,
              "Re-synced from the server."
            )
          }
        >
          Re-sync from server
        </button>
        {message && <p className="text-xs text-[var(--muted)]">{message}</p>}
      </section>
    </div>
  );
}
