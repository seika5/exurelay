/**
 * Copying message history to my own other devices (DESIGN.md §5 "History to a new device"). The messages saved on
 * this device go, in batches, as hidden `history` messages sealed to my devices only, like device_sync. Each keeps its
 * blob's expiry, so it's deleted on the same schedule everywhere. File contents stay behind: every member downloads
 * every blob (recipient-blind storage), so the whole copy is capped and kept to text.
 */

import type { DecryptedMessage } from "./blobPayload";
import { expired, type CachedMessage } from "./messageCache";

export const HISTORY_BATCH_BYTES = 192 * 1024;
export const HISTORY_TOTAL_BYTES = 2 * 1024 * 1024;

/** Kinds copied as they are; files go without their contents; device_sync and history themselves never. */
const COPIED = new Set(["text", "file", "contact", "call_event", "group_rename", "group_members", "plugin"]);

export type HistoryPlan = {
  batches: CachedMessage[][];
  /** Messages in the batches. */
  copied: number;
  /** File messages copied without their contents. */
  filesWithoutContent: number;
  /** Older messages left out to stay under the total size. */
  leftOut: number;
};

/** The newest messages first, up to the total size, split into batches of at most `batchBytes` each. */
export function planHistory(
  saved: CachedMessage[],
  { batchBytes = HISTORY_BATCH_BYTES, totalBytes = HISTORY_TOTAL_BYTES, retentionDays, now = Date.now() }: { batchBytes?: number; totalBytes?: number; retentionDays: number; now?: number }
): HistoryPlan {
  const kept = saved.filter((c) => COPIED.has(c.message.type) && !expired(c, retentionDays, now)).sort((a, b) => b.message.sentAt - a.message.sentAt);
  const batches: CachedMessage[][] = [];
  let batch: CachedMessage[] = [];
  let batchSize = 0;
  let total = 0;
  let filesWithoutContent = 0;
  let copied = 0;
  for (const c of kept) {
    const message = (c.message.type === "file" ? { ...c.message, body: "", removed: true } : c.message) as DecryptedMessage;
    const item = { message, expiresAt: c.expiresAt };
    const size = new TextEncoder().encode(JSON.stringify(item)).length;
    if (size > batchBytes || total + size > totalBytes) break;
    if (batchSize + size > batchBytes) {
      batches.push(batch);
      batch = [];
      batchSize = 0;
    }
    batch.push(item);
    batchSize += size;
    total += size;
    copied++;
    if (c.message.type === "file") filesWithoutContent++;
  }
  if (batch.length) batches.push(batch);
  return { batches, copied, filesWithoutContent, leftOut: kept.length - copied };
}

/**
 * The items of a history message from another of my devices that are worth keeping: well-formed, of a kind that's
 * copied, not already here, and not past retention.
 */
export function acceptHistory(items: unknown, has: (messageId: string) => boolean, retentionDays: number, now = Date.now()): CachedMessage[] {
  if (!Array.isArray(items)) return [];
  const out: CachedMessage[] = [];
  for (const it of items) {
    const m = it?.message;
    if (!m || typeof m !== "object" || typeof m.messageId !== "string" || typeof m.senderKeyHash !== "string") continue;
    if (!Number.isSafeInteger(m.sentAt) || !Number.isSafeInteger(it.expiresAt) || !COPIED.has(m.type)) continue;
    const item = { message: m as DecryptedMessage, expiresAt: it.expiresAt as number };
    if (has(m.messageId) || out.some((o) => o.message.messageId === m.messageId) || expired(item, retentionDays, now)) continue;
    out.push(item);
  }
  return out;
}
