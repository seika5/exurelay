"use client";

import { useState } from "react";
import type { Conversation, StorageStats } from "@/lib/useMessages";
import { MAX_RETENTION_DAYS } from "@/lib/messageCache";
import { SectionTitle } from "@/components/InfoTip";
import { IconButton } from "@/components/icons";
import { confirmDialog } from "@/components/Modal";
import { btnDanger, btnPrimary, field } from "@/components/ui";
import { ScrollList } from "@/components/ScrollList";

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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const daysValue = Math.round(Number(days));
  const daysValid = Number.isFinite(daysValue) && daysValue >= 1 && daysValue <= MAX_RETENTION_DAYS;
  const saveDays = () => {
    if (!daysValid) return;
    storage.setRetentionDays(daysValue);
    setDays(String(daysValue));
  };

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
            onKeyDown={(e) => e.key === "Enter" && saveDays()}
            aria-label="Days"
            className={`${field} w-20`}
          />
          <span className="flex-1">days after the server deletes them</span>
          <button type="button" disabled={!daysValid || daysValue === storage.retentionDays} onClick={saveDays} className={btnPrimary}>
            Save
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle tip="Clears this device only, then downloads again what the server still has (the last 3 to 4 days). Others keep their copies.">
          Clear storage
        </SectionTitle>
        {conversations.length > 0 && (
          <ScrollList>
            {conversations.map((c, i) => (
              <li key={i} className="flex items-center gap-2 pl-3 pr-1 py-1">
                <span className="flex-1 min-w-0 truncate">{c.label}</span>
                <IconButton
                  icon="trash"
                  label={`Clear ${c.label}`}
                  danger
                  disabled={busy}
                  onClick={() => act(`Clear "${c.label}" from this device? What the server still has of it downloads again.`, "Clear", () => storage.clearConversation(c.conv), "Chat cleared.")}
                />
              </li>
            ))}
          </ScrollList>
        )}
        <button
          type="button"
          disabled={busy}
          className={`${btnDanger} self-start`}
          onClick={() =>
            act("Clear every message from this device? What the server still has downloads again. Others keep their copies.", "Clear", storage.resync, "All messages cleared.")
          }
        >
          Clear all messages
        </button>
        {message && <p className="text-xs text-[var(--muted)]">{message}</p>}
      </section>
    </div>
  );
}
