/**
 * Encrypted local message cache (DESIGN.md §5 "As built (phase 5b)"), one per identity (owner = its keyHash).
 *
 * Each message is its own IndexedDB record, AES-256-GCM encrypted with the cache key and bound to its owner and
 * messageId; the sync cursor is encrypted the same way. The cache key is derived from the passphrase in folder mode
 * (identityFile.ts), so the cache can't be read without unlocking, or is a random non-extractable key kept in
 * IndexedDB in app-storage mode. Nothing about a message is stored in the clear except that it exists.
 */

import type { DecryptedMessage } from "./blobPayload";
import { CACHE_KEYS, CACHE_MESSAGES, CACHE_META, run } from "./keystore";

/** A kept message and its blob's server expiry (retention counts from that, not from sentAt). */
export type CachedMessage = { message: DecryptedMessage; expiresAt: number };

/** Sync position, and per conversation the newest sentAt you've seen there (for the mention badge). */
export type CacheMeta = { cursor: string; read: Record<string, number> };

type Sealed = { iv: Uint8Array; ct: Uint8Array };
type MessageRecord = Sealed & { id: string; owner: string };
type MetaRecord = Sealed & { owner: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

async function seal(key: CryptoKey, aad: string, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)))
  );
  return { iv, ct };
}

async function open<T>(key: CryptoKey, aad: string, s: Sealed): Promise<T> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: s.iv as BufferSource, additionalData: enc.encode(aad) },
    key,
    s.ct as BufferSource
  );
  return JSON.parse(dec.decode(pt)) as T;
}

const recordId = (owner: string, messageId: string) => `${owner}|${messageId}`;

/** App-storage mode: this identity's cache key, made on first use. Non-extractable, like the identity keys. */
export async function appCacheKey(owner: string): Promise<CryptoKey> {
  const found = await run<{ owner: string; key: CryptoKey } | undefined>("readonly", (s) => s.get(owner), CACHE_KEYS);
  if (found) return found.key;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await run("readwrite", (s) => s.put({ owner, key }), CACHE_KEYS);
  return key;
}

/** Everything cached for this identity. Records that don't decrypt (another key, damaged) are skipped. */
export async function loadCache(owner: string, key: CryptoKey): Promise<{ messages: CachedMessage[] } & CacheMeta> {
  const records = await run<MessageRecord[]>("readonly", (s) => s.index("owner").getAll(owner), CACHE_MESSAGES);
  const messages: CachedMessage[] = [];
  for (const r of records) {
    try {
      messages.push(await open<CachedMessage>(key, r.id, r));
    } catch {
      // Not readable with this key: leave it for wipeCache.
    }
  }
  let meta: CacheMeta = { cursor: "0", read: {} };
  const record = await run<MetaRecord | undefined>("readonly", (s) => s.get(owner), CACHE_META);
  if (record) {
    try {
      const m = await open<Partial<CacheMeta>>(key, `${owner}|meta`, record);
      meta = { cursor: typeof m.cursor === "string" ? m.cursor : "0", read: m.read ?? {} };
    } catch {
      // Unreadable sync state: start over (messages already here are deduplicated by messageId).
    }
  }
  return { messages, ...meta };
}

export async function saveMessages(owner: string, key: CryptoKey, items: CachedMessage[]): Promise<void> {
  for (const item of items) {
    const id = recordId(owner, item.message.messageId);
    const record: MessageRecord = { id, owner, ...(await seal(key, id, item)) };
    await run("readwrite", (s) => s.put(record), CACHE_MESSAGES);
  }
}

export async function saveMeta(owner: string, key: CryptoKey, meta: CacheMeta): Promise<void> {
  const record: MetaRecord = { owner, ...(await seal(key, `${owner}|meta`, meta)) };
  await run("readwrite", (s) => s.put(record), CACHE_META);
}

/**
 * Each group's latest name and picture, with when they were set, so they outlast the messages that set them (those
 * expire like any other). Dropped for a group once none of its messages are left (page.tsx).
 */
export type GroupInfo = Record<string, { name?: string; nameAt?: number; icon?: string; iconAt?: number }>;

export async function loadGroupInfo(owner: string, key: CryptoKey): Promise<GroupInfo> {
  const record = await run<MetaRecord | undefined>("readonly", (s) => s.get(`${owner}|groups`), CACHE_META);
  if (!record) return {};
  try {
    return await open<GroupInfo>(key, `${owner}|groups`, record);
  } catch {
    return {};
  }
}

export async function saveGroupInfo(owner: string, key: CryptoKey, info: GroupInfo): Promise<void> {
  const record: MetaRecord = { owner: `${owner}|groups`, ...(await seal(key, `${owner}|groups`, info)) };
  await run("readwrite", (s) => s.put(record), CACHE_META);
}

export async function deleteMessages(owner: string, messageIds: string[]): Promise<void> {
  for (const m of messageIds) await run("readwrite", (s) => s.delete(recordId(owner, m)), CACHE_MESSAGES);
}

/**
 * Remove this identity's cached messages ("messages"), also its sync position so the next sync starts over
 * ("sync"), or also its app-mode cache key, for leaving or logging out ("all").
 */
export async function wipeCache(owner: string, scope: "messages" | "sync" | "all" = "all"): Promise<void> {
  const ids = await run<IDBValidKey[]>("readonly", (s) => s.index("owner").getAllKeys(owner), CACHE_MESSAGES);
  for (const id of ids) await run("readwrite", (s) => s.delete(id), CACHE_MESSAGES);
  if (scope !== "messages") await run("readwrite", (s) => s.delete(owner), CACHE_META);
  if (scope === "all") await run("readwrite", (s) => s.delete(`${owner}|groups`), CACHE_META);
  if (scope === "all") await run("readwrite", (s) => s.delete(owner), CACHE_KEYS);
}

/** Retention: a message goes at its blob's expiresAt + days (DESIGN.md §5). */
export const DEFAULT_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 365;
export const expired = (m: CachedMessage, days: number, now = Date.now()) => m.expiresAt + days * 86_400_000 < now;
