"use client";

import { tallyReactions, type Reaction } from "./reactions";
import { tallyActions, type MessageActions } from "./messageActions";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ApiError, getBlobsSince, postBlobs } from "@/lib/api";
import { createSocket } from "@/lib/socket";
import { checkPeerIssuer, currentIssuerId, RateLimitError } from "@/lib/tokens";
import { decodeMessage, encodeMessage, type DecryptedMessage } from "@/lib/blobPayload";
import { acceptHistory, planHistory, type HistoryPlan } from "@/lib/historyTransfer";
import type { Contact, ContactSettings } from "@/lib/keystore";
import { BATCH, Opener, sealSend, DEFAULT_BLOB_SIZE, DEFAULT_DECOYS, type Opened } from "@/lib/sealed";
import {
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  deleteMessages,
  expired,
  loadCache,
  saveMeta,
  saveMessages,
  wipeCache,
  type CachedMessage,
} from "@/lib/messageCache";
import { serverScopedKey } from "@/lib/server";

const RETENTION_KEY = "relay.retentionDays";

function readRetention(): number {
  try {
    const n = Number(localStorage.getItem(serverScopedKey(RETENTION_KEY)));
    return Number.isInteger(n) && n >= 1 && n <= MAX_RETENTION_DAYS ? n : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

/** What Settings → Storage shows: sizes are of the decrypted messages as kept on this device. */
export type StorageStats = { messages: number; messageBytes: number; files: number; fileBytes: number };

function storageStats(list: DecryptedMessage[]): StorageStats {
  const st: StorageStats = { messages: 0, messageBytes: 0, files: 0, fileBytes: 0 };
  for (const m of list) {
    const size = JSON.stringify(m).length;
    if (m.type === "file" && !m.removed) {
      st.files++;
      st.fileBytes += size;
    } else {
      st.messages++;
      st.messageBytes += size;
    }
  }
  return st;
}

/** Several "blobs" pings in a row (e.g. a multi-batch send) cost one sync. Each page fetched costs one token. */
const REFRESH_DEBOUNCE_MS = 1500;

/**
 * Protocol v2 (sealed.ts): every member downloads every blob once, from a cursor, and keeps what decrypts.
 * Kept messages and the cursor live in the encrypted local cache (messageCache.ts), so a launch only downloads
 * what's new. Our own messages come back through the self-copy slot. Until then, a message we sent is shown from
 * the outbox:
 *
 * - "sending" (drawn faded): queued or in flight. The queue sends one message at a time, in order. Out of tokens
 *   (the server's rate limit), it waits until there are some and carries on; the messages just stay faded.
 * - "sent": the server has every blob; shown normally until our self-copy replaces it.
 * - "failed": the server refused it (any 4xx other than the rate limit), or it couldn't be reached for about a
 *   minute of retries. Shown with Retry and Cancel.
 */
export type OutboxStatus = "sending" | "sent" | "failed";
export type ShownMessage = DecryptedMessage & { outbox?: { id: string; status: OutboxStatus } };

/** Message kinds shown in conversations; anything else (hidden kinds, or a newer version's) isn't. */
const SHOWN_KINDS = new Set<string>(["text", "file", "contact", "call_event", "group_rename", "plugin"]);
/** Kinds only my own devices send each other, applied and never shown. */
const HIDDEN_KINDS = new Set<string>(["device_sync", "history"]);
type OutboxEntry = { id: string; message: DecryptedMessage; status: OutboxStatus; post: () => Promise<void> };

/** Waits between retries when the server can't be reached (or errs); after the last, the message is "failed". */
const UNREACHABLE_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

/** How long to wait before trying again, or null to give up and mark the message failed. */
export function retryDelay(e: unknown, attempt: number): number | null {
  // Never give up on the rate limit: tokens always come back.
  if (e instanceof RateLimitError) return Math.max(1, e.retryAfter) * 1000;
  // The server refused this request; trying again won't change that.
  if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 409) return null;
  // Unreachable, a 5xx, or a key change mid-request.
  return UNREACHABLE_BACKOFF_MS[attempt] ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const outboxMatch = (a: DecryptedMessage, b: DecryptedMessage) => a.messageId === b.messageId;

export type Conversation = { type: "dm"; otherKeyHash: string } | { type: "group"; memberKeyHashes: string[] };

export function conversationId(c: Conversation, myKeyHash: string): string {
  if (c.type === "dm") return `dm:${[myKeyHash, c.otherKeyHash].sort().join(",")}`;
  return `group:${[...c.memberKeyHashes].sort().join(",")}`;
}

/** True if this message belongs in this conversation. Group messages never belong in a DM. */
/** The conversation a message belongs to, as the chat list groups them. */
export function conversationIdOf(m: DecryptedMessage, myKeyHash: string): string | null {
  if (m.groupMemberKeyHashes && m.groupMemberKeyHashes.length >= 2) return conversationId({ type: "group", memberKeyHashes: m.groupMemberKeyHashes }, myKeyHash);
  const other = m.senderKeyHash === myKeyHash ? m.recipientKeyHash : m.senderKeyHash;
  return other ? conversationId({ type: "dm", otherKeyHash: other }, myKeyHash) : null;
}

export function messageBelongsToConversation(
  msg: DecryptedMessage,
  conv: Conversation,
  myKeyHash: string
): boolean {
  if (conv.type === "dm") {
    if (msg.groupMemberKeyHashes) return false;
    const a = msg.senderKeyHash;
    const b = msg.recipientKeyHash ?? (msg.senderKeyHash === myKeyHash ? undefined : msg.senderKeyHash);
    const pair = new Set([myKeyHash, conv.otherKeyHash]);
    return pair.has(a) && (b == null || pair.has(b));
  }
  if (!msg.groupMemberKeyHashes) return false;
  const g = new Set([...msg.groupMemberKeyHashes].sort());
  const c = new Set([...conv.memberKeyHashes].sort());
  return g.size === c.size && Array.from(g).every((k) => c.has(k));
}

export function useMessages(
  /** keyHash is the member I am; deviceKeyHash and keyPair are this device's (linked devices, DESIGN.md §4). */
  identity: {
    keyPair: CryptoKeyPair;
    keyHash: string;
    deviceKeyHash: string;
    publicKeyBase64: string;
    contacts: Contact[];
    myDevices: { keyHash: string; ecdh: string }[];
  } | null,
  /** From the admin-signed directory (blobSettings in signed.ts). */
  blobs: { blobSize: number; decoys: number } = { blobSize: DEFAULT_BLOB_SIZE, decoys: DEFAULT_DECOYS },
  /** The local cache key (IdentityContext), or null to keep nothing between launches. */
  cacheKey: CryptoKey | null = null,
  /** Name and contact settings synced from another of my devices. */
  onDeviceSync?: (sync: { myName: string; contactSettings: ContactSettings[]; settingsAt: number }) => void
) {
  const [receivedMessages, setReceivedMessages] = useState<DecryptedMessage[]>([]);
  // Sync state for this identity: where we are on the server, the trial decrypter, and what we've kept, by messageId.
  const cursor = useRef("0");
  const opener = useRef<Opener | null>(null);
  const received = useRef(new Map<string, CachedMessage>());
  /** Settles once the cache is loaded; syncing waits for it so it resumes from the cached cursor. */
  const cacheLoaded = useRef<Promise<void>>(Promise.resolve());
  const [retentionDays, setRetentionState] = useState(DEFAULT_RETENTION_DAYS);
  // Per conversation id, the newest sentAt seen there (saved with the cursor in the encrypted cache).
  const readRef = useRef<Record<string, number>>({});
  /** The cursor last saved: safe to resume from (cursor.current may be past a send still waiting for pieces). */
  const savedCursor = useRef("0");
  const [readMarks, setReadMarks] = useState<Record<string, number>>({});
  /** The cache has been read (or there is none): read marks and kept messages are in place. */
  const [cacheReady, setCacheReady] = useState(false);
  /** A download that has taken more than a moment (boot, catching up), for a spinner. */
  const [loading, setLoading] = useState(false);
  const syncing = useRef<Promise<void> | null>(null);
  const syncAgain = useRef(false);
  /** Settings syncs between my devices seen this session (never shown, never cached). */
  const syncedIds = useRef(new Set<string>());
  const [outbox, setOutboxState] = useState<OutboxEntry[]>([]);
  // The queue worker reads the outbox outside React renders, so keep the latest copy in a ref too.
  const outboxRef = useRef<OutboxEntry[]>([]);
  const setOutbox = useCallback((fn: (box: OutboxEntry[]) => OutboxEntry[]) => {
    outboxRef.current = fn(outboxRef.current);
    setOutboxState(outboxRef.current);
  }, []);
  const draining = useRef(false);
  /** Set while the socket is up: schedules a sync after a delay. */
  const syncLater = useRef<((ms: number) => void) | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);

  const contactByKeyHash = new Map(identity?.contacts.map((c) => [c.keyHash, c]) ?? []);

  const messages = useMemo(() => {
    // Only kinds this version shows: a newer one's message kinds never appear as blank messages here.
    const list: ShownMessage[] = receivedMessages.filter((m) => SHOWN_KINDS.has(m.type));
    for (const o of outbox) {
      if (!SHOWN_KINDS.has(o.message.type)) continue;
      if (!receivedMessages.some((m) => outboxMatch(m, o.message))) list.push({ ...o.message, outbox: { id: o.id, status: o.status } });
    }
    list.sort((a, b) => a.sentAt - b.sentAt);
    return list;
  }, [receivedMessages, outbox]);

  /** Reactions on each message by its id, including ones still on their way (they show at once). */
  const reactions = useMemo(() => {
    if (!identity) return new Map<string, Reaction[]>();
    const pending = outbox.map((o) => o.message).filter((m) => m.type === "reaction" && !receivedMessages.some((r) => r.messageId === m.messageId));
    return tallyReactions([...receivedMessages, ...pending, ...outbox.map((o) => o.message).filter((m) => m.type !== "reaction")], identity.keyHash);
  }, [receivedMessages, outbox, identity]);

  /** Edits and deletes for everyone, including ones still on their way. */
  const actions = useMemo((): MessageActions => {
    if (!identity) return { edits: new Map(), deleted: new Set() };
    const pending = outbox.map((o) => o.message).filter((m) => !receivedMessages.some((r) => r.messageId === m.messageId));
    return tallyActions([...receivedMessages, ...pending], identity.keyHash);
  }, [receivedMessages, outbox, identity]);

  const owner = identity?.keyHash ?? null;

  /** Show what's kept, newest last, after dropping anything past retention (from memory and the cache). */
  const publish = useCallback(async () => {
    const days = readRetention();
    const gone = [...received.current.values()].filter((c) => expired(c, days)).map((c) => c.message.messageId);
    for (const id of gone) received.current.delete(id);
    if (gone.length && owner && cacheKey) await deleteMessages(owner, gone).catch(() => {});
    // A file its sender deleted for everyone: drop its contents here too, as Clear files does.
    if (owner) {
      const changed: CachedMessage[] = [];
      for (const id of tallyActions([...received.current.values()].map((c) => c.message), owner).deleted) {
        const c = received.current.get(id);
        if (c?.message.type !== "file" || c.message.removed) continue;
        const next = { ...c, message: { ...c.message, body: "", removed: true } };
        received.current.set(id, next);
        changed.push(next);
      }
      if (changed.length && cacheKey) await saveMessages(owner, cacheKey, changed).catch(() => {});
    }
    setReceivedMessages([...received.current.values()].map((c) => c.message).sort((a, b) => a.sentAt - b.sentAt));
  }, [owner, cacheKey]);

  /** Messages already seen on another of my devices (copied history): move their conversations' read marks past them. */
  const seenAlready = (items: CachedMessage[]) => {
    const me = identity?.keyHash;
    if (!me || items.length === 0) return;
    const next = { ...readRef.current };
    for (const { message: m } of items) {
      const id = conversationIdOf(m, me);
      if (id && (next[id] ?? 0) < m.sentAt) next[id] = m.sentAt;
    }
    readRef.current = next;
    setReadMarks(next);
  };

  /** Download every blob after our cursor and keep the messages that decrypt for us from a current member. */
  const syncOnce = useCallback(async () => {
    if (!identity) return;
    await cacheLoaded.current;
    // Every device of every contact, and of mine, can be a sender: the opener tries each one's tag on every blob.
    const senders = new Map<string, string>();
    const memberOf = new Map<string, string>();
    for (const c of identity.contacts) {
      for (const d of c.devices) {
        senders.set(d.keyHash, d.publicKey);
        memberOf.set(d.keyHash, c.keyHash);
      }
    }
    for (const d of identity.myDevices) {
      senders.set(d.keyHash, d.ecdh);
      memberOf.set(d.keyHash, identity.keyHash);
    }
    senders.set(identity.deviceKeyHash, identity.publicKeyBase64);
    memberOf.set(identity.deviceKeyHash, identity.keyHash);
    opener.current ??= new Opener(identity.keyPair, identity.deviceKeyHash);
    const fresh: CachedMessage[] = [];
    const keep = (opened: Opened) => {
      try {
        const msg = decodeMessage(new TextDecoder().decode(opened.payload));
        // The slot proved which device sent it; the message must name that device's member.
        if (typeof msg.messageId !== "string" || msg.senderKeyHash !== memberOf.get(opened.senderKeyHash)) return;
        if (msg.type === "device_sync") {
          // From another of my devices: apply it, never show it.
          if (msg.senderKeyHash === identity.keyHash) onDeviceSync?.(msg);
          syncedIds.current.add(msg.messageId);
          return;
        }
        if (msg.type === "history") {
          // Messages another of my devices had saved: keep the ones I don't have, with their original expiry. They were
          // seen there, so they count as read here.
          if (msg.senderKeyHash === identity.keyHash) {
            const items = acceptHistory(msg.items, (id) => received.current.has(id), readRetention());
            for (const item of items) {
              received.current.set(item.message.messageId, item);
              fresh.push(item);
            }
            seenAlready(items);
          }
          syncedIds.current.add(msg.messageId);
          return;
        }
        if (!received.current.has(msg.messageId)) {
          const item = { message: msg, expiresAt: opened.expiresAt };
          received.current.set(msg.messageId, item);
          fresh.push(item);
        }
      } catch {
        // Not a message we understand.
      }
    };
    // A member we've only just learned about may have sent something we already passed over.
    (await opener.current.setMembers(senders)).forEach(keep);
    const from = cursor.current;
    for (let more = true; more; ) {
      const page = await getBlobsSince(cursor.current);
      for (const b of page.blobs) {
        const opened = await opener.current.add(b);
        cursor.current = b.seq;
        if (opened) keep(opened);
      }
      more = page.more;
    }
    if (owner && cacheKey) {
      if (fresh.length) await saveMessages(owner, cacheKey, fresh);
      // Each upload batch is stored in one insert, so a finished sync has seen every batch whole: resume after the
      // last blob, except before a send still waiting for pieces from a later batch.
      if (cursor.current !== from) {
        let safe = BigInt(cursor.current);
        const pending = opener.current.oldestPendingSeq();
        if (pending !== null && BigInt(pending) - BigInt(1) < safe) safe = BigInt(pending) - BigInt(1);
        savedCursor.current = safe.toString();
        await saveMeta(owner, cacheKey, { cursor: savedCursor.current, read: readRef.current });
      }
    }
    // Our self-copy is back: those messages no longer need the outbox.
    setOutbox((box) =>
      box.filter((o) => o.status !== "sent" || !(received.current.has(o.message.messageId) || syncedIds.current.has(o.message.messageId)))
    );
    if (fresh.length === 0) return;
    await publish();
    // Cross-check the token keys other members are using (see tokens.ts).
    const issuers = new Set(fresh.map((c) => c.message).filter((m) => m.senderKeyHash !== identity.keyHash && m.issuer).map((m) => m.issuer!));
    for (const id of issuers) checkPeerIssuer(id).catch(() => {});
  }, [identity, setOutbox, owner, cacheKey, publish, onDeviceSync]);

  /** One sync at a time; a ping during a sync runs one more afterwards. */
  const syncFailures = useRef(0);
  const loadBlobs = useCallback(async () => {
    if (syncing.current) {
      syncAgain.current = true;
      return syncing.current;
    }
    // Only a download that takes a while shows the spinner, so a single new message doesn't flash it.
    const slow = setTimeout(() => setLoading(true), 500);
    syncing.current = (async () => {
      try {
        do {
          syncAgain.current = false;
          await syncOnce();
        } while (syncAgain.current && alive.current);
        syncFailures.current = 0;
        setError(null);
      } catch (e) {
        // Out of tokens: sync again once there are some (from the same cursor).
        if (e instanceof RateLimitError) syncLater.current?.(e.retryAfter * 1000);
        else {
          // Try again quietly, waiting longer each time (5 s, 15 s, 45 s, then every 2 minutes). Only a problem
          // that lasts (about a minute of failures) is worth telling the user about.
          const n = ++syncFailures.current;
          syncLater.current?.(Math.min(5_000 * 3 ** (n - 1), 120_000));
          if (n >= 4) setError("Can't reach the server. Trying again.");
        }
      } finally {
        clearTimeout(slow);
        setLoading(false);
        syncing.current = null;
      }
    })();
    return syncing.current;
  }, [syncOnce]);

  // Fetch blobs only on initial load and when the server notifies us (socket "blobs"). No polling.
  useEffect(() => {
    if (!identity) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = (delay = REFRESH_DEBOUNCE_MS) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        loadBlobs();
      }, delay);
    };
    syncLater.current = soon;
    const socket = createSocket();
    socket.on("connect", () => soon());
    socket.on("blobs", () => soon());
    return () => {
      syncLater.current = null;
      if (timer) clearTimeout(timer);
      socket.close();
    };
  }, [identity?.keyHash, loadBlobs]);

  // A new member or device in the list: their recent sends may be among the blobs the opener couldn't place yet.
  const memberKey = [
    ...(identity?.contacts.flatMap((c) => c.devices.map((d) => d.keyHash)) ?? []),
    ...(identity?.myDevices.map((d) => d.keyHash) ?? []),
  ]
    .sort()
    .join(",");
  useEffect(() => {
    if (opener.current) loadBlobs();
  }, [memberKey, loadBlobs]);

  const conversations = useMemo(() => {
    const myKeyHash = identity?.keyHash ?? "";
    const seen = new Set<string>();
    const list: Conversation[] = [];
    for (const m of messages) {
      if (m.groupMemberKeyHashes && m.groupMemberKeyHashes.length >= 2) {
        const id = conversationId({ type: "group", memberKeyHashes: m.groupMemberKeyHashes }, myKeyHash);
        if (!seen.has(id)) {
          seen.add(id);
          list.push({ type: "group", memberKeyHashes: m.groupMemberKeyHashes });
        }
      } else {
        const other =
          m.senderKeyHash === identity?.keyHash ? m.recipientKeyHash : m.senderKeyHash;
        if (other) {
          const id = conversationId({ type: "dm", otherKeyHash: other }, myKeyHash);
          if (!seen.has(id)) {
            seen.add(id);
            list.push({ type: "dm", otherKeyHash: other });
          }
        }
      }
    }
    const lastAt = (c: Conversation): number => {
      let max = 0;
      for (const m of messages) {
        if (messageBelongsToConversation(m, c, myKeyHash)) max = Math.max(max, m.sentAt);
      }
      return max;
    };
    return list.sort((a, b) => lastAt(b) - lastAt(a));
  }, [identity?.keyHash, messages]);

  const setStatus = useCallback(
    (id: string, status: OutboxStatus) => setOutbox((box) => box.map((o) => (o.id === id ? { ...o, status } : o))),
    [setOutbox]
  );

  /** Send queued messages one at a time, oldest first, until none are left. */
  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      for (;;) {
        const next = outboxRef.current.find((o) => o.status === "sending");
        if (!next || !alive.current) return;
        for (let attempt = 0; ; ) {
          try {
            await next.post();
            // The server's "blobs" ping brings our self-copy back, which clears this entry.
            setStatus(next.id, "sent");
            break;
          } catch (e) {
            const wait = retryDelay(e, e instanceof RateLimitError ? 0 : attempt++);
            if (wait === null) {
              setStatus(next.id, "failed");
              break;
            }
            await sleep(wait);
            // Cancelled while we waited, or the chat went away.
            if (!alive.current) return;
            if (!outboxRef.current.some((o) => o.id === next.id && o.status === "sending")) break;
          }
        }
      }
    } finally {
      draining.current = false;
    }
  }, [setStatus]);

  /** Queue a message. It shows at once (faded) and is sent in order behind anything already queued. */
  const sendMessage = useCallback(
    async (
      message: Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">,
      recipientKeyHashes: string[],
      options?: { recipientKeyHash?: string }
    ) => {
      if (!identity) return;
      const fullMessage = {
        ...message,
        messageId: crypto.randomUUID(),
        senderKeyHash: identity.keyHash,
        sentAt: Date.now(),
        recipientKeyHash: options?.recipientKeyHash,
      } as DecryptedMessage;

      // Sealed once, when its turn comes; a retry resumes with the first batch the server didn't take.
      let prepared: Uint8Array[] | null = null;
      let posted = 0;
      const post = async () => {
        if (!prepared) {
          // A slot for every device of every recipient, and for every device of mine (the self-copy and sync).
          const recipients = recipientKeyHashes
            .map((k) => contactByKeyHash.get(k))
            .filter((c): c is Contact => !!c)
            .flatMap((c) => c.devices);
          const mine = [
            { keyHash: identity.deviceKeyHash, publicKey: identity.publicKeyBase64 },
            ...identity.myDevices.filter((d) => d.keyHash !== identity.deviceKeyHash).map((d) => ({ keyHash: d.keyHash, publicKey: d.ecdh })),
          ];
          const sealed = { ...fullMessage, issuer: await currentIssuerId() };
          prepared = await sealSend({
            senderKeyPair: identity.keyPair,
            senderKeyHash: identity.deviceKeyHash,
            recipients: [...recipients, ...mine],
            payload: new TextEncoder().encode(encodeMessage(sealed)),
            blobSize: blobs.blobSize,
            maxDecoys: blobs.decoys,
          });
        }
        // In sealSend's order (the head is somewhere in the first batch); one token per batch.
        for (; posted < prepared.length; posted += BATCH) {
          await postBlobs(prepared.slice(posted, posted + BATCH));
        }
      };
      setOutbox((box) => [...box, { id: crypto.randomUUID(), message: fullMessage, status: "sending", post }]);
      drain();
    },
    [identity, contactByKeyHash, setOutbox, drain, blobs.blobSize, blobs.decoys]
  );

  /** Copy the messages saved here to my other devices (historyTransfer.ts). Returns what was sent. */
  const sendHistory = useCallback(async (): Promise<HistoryPlan> => {
    await cacheLoaded.current;
    const plan = planHistory([...received.current.values()], { retentionDays: readRetention() });
    for (const items of plan.batches) {
      await sendMessage({ type: "history", items } as Omit<DecryptedMessage, "senderKeyHash" | "sentAt" | "messageId">, []);
    }
    return plan;
  }, [sendMessage]);

  const retrySend = useCallback(
    (id: string) => {
      setStatus(id, "sending");
      drain();
    },
    [setStatus, drain]
  );
  const cancelSend = useCallback((id: string) => setOutbox((box) => box.filter((o) => o.id !== id)), [setOutbox]);

  // A different identity starts with an empty outbox, then loads its cache and resumes from its cursor.
  useEffect(() => {
    setOutbox(() => []);
    setReceivedMessages([]);
    setCacheReady(false);
    cursor.current = "0";
    opener.current = null;
    received.current = new Map();
    syncedIds.current = new Set();
    savedCursor.current = "0";
    readRef.current = {};
    setReadMarks({});
    setRetentionState(readRetention());
    if (!owner || !cacheKey) {
      cacheLoaded.current = Promise.resolve();
      setCacheReady(true);
      return;
    }
    cacheLoaded.current = loadCache(owner, cacheKey).then(
      async ({ messages: kept, cursor: from, read }) => {
        // A version that didn't know a hidden kind saved it like a message. Unpack history from my own devices now,
        // and drop those records: they're never shown.
        const hidden = kept.filter((c) => HIDDEN_KINDS.has(c.message.type));
        for (const c of kept) if (!HIDDEN_KINDS.has(c.message.type)) received.current.set(c.message.messageId, c);
        const unpacked: CachedMessage[] = [];
        readRef.current = read;
        for (const c of hidden) {
          if (c.message.type !== "history" || c.message.senderKeyHash !== owner) continue;
          for (const item of acceptHistory(c.message.items, (id) => received.current.has(id), readRetention())) {
            received.current.set(item.message.messageId, item);
            unpacked.push(item);
          }
        }
        seenAlready(unpacked);
        if (unpacked.length) await saveMessages(owner, cacheKey, unpacked).catch(() => {});
        if (hidden.length) await deleteMessages(owner, hidden.map((c) => c.message.messageId)).catch(() => {});
        cursor.current = from;
        savedCursor.current = from;
        setReadMarks(readRef.current);
        if (unpacked.length) await saveMeta(owner, cacheKey, { cursor: from, read: readRef.current }).catch(() => {});
        await publish();
        setCacheReady(true);
      },
      () => setCacheReady(true) // unreadable cache: sync from the start
    );
  }, [owner, cacheKey, setOutbox, publish]);

  // ---------------------------------------------------------------------------
  // Settings → Storage
  // ---------------------------------------------------------------------------

  const setRetentionDays = useCallback(
    (days: number) => {
      const n = Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.round(days)));
      try {
        localStorage.setItem(serverScopedKey(RETENTION_KEY), String(n));
      } catch {
        // Storage unavailable: applies for this session only.
      }
      setRetentionState(n);
      publish();
    },
    [publish]
  );

  /** Keep file messages but drop their contents from this device. */
  const clearFiles = useCallback(async () => {
    const changed: CachedMessage[] = [];
    for (const c of received.current.values()) {
      if (c.message.type === "file" && !c.message.removed) {
        const next = { ...c, message: { ...c.message, body: "", removed: true } };
        received.current.set(c.message.messageId, next);
        changed.push(next);
      }
    }
    if (owner && cacheKey) await saveMessages(owner, cacheKey, changed);
    await publish();
  }, [owner, cacheKey, publish]);

  /** Download everything the server still holds again, keeping what's here (anything already here is skipped). */
  const downloadAgain = useCallback(async () => {
    cursor.current = "0";
    savedCursor.current = "0";
    opener.current = null;
    if (owner && cacheKey) await saveMeta(owner, cacheKey, { cursor: "0", read: readRef.current });
    await loadBlobs();
  }, [owner, cacheKey, loadBlobs]);

  /** Clear a conversation from this device, then download what the server still has of it (the last ~3–4 days). */
  const clearConversation = useCallback(
    async (conv: Conversation) => {
      if (!identity) return;
      const ids = [...received.current.values()]
        .filter((c) => messageBelongsToConversation(c.message, conv, identity.keyHash))
        .map((c) => c.message.messageId);
      for (const id of ids) received.current.delete(id);
      if (owner) await deleteMessages(owner, ids);
      await publish();
      await downloadAgain();
    },
    [identity, owner, publish, downloadAgain]
  );

  /** Clear everything kept on this device. Messages still on the server don't come back unless you re-sync. */
  const clearAll = useCallback(async () => {
    received.current = new Map();
    if (owner) await wipeCache(owner, "messages");
    await publish();
  }, [owner, publish]);

  /** Clear everything and download again whatever the server still holds (the last ~3–4 days). */
  const resync = useCallback(async () => {
    received.current = new Map();
    cursor.current = "0";
    savedCursor.current = "0";
    opener.current = null;
    if (owner) await wipeCache(owner, "sync");
    // Keep what you've read, so old mentions don't light up again.
    if (owner && cacheKey) await saveMeta(owner, cacheKey, { cursor: "0", read: readRef.current });
    await publish();
    await loadBlobs();
  }, [owner, cacheKey, publish, loadBlobs]);

  /** You've seen this conversation up to `upTo` (a sentAt): clears its mention badge. */
  const markRead = useCallback(
    (conv: Conversation, upTo: number) => {
      if (!identity) return;
      const id = conversationId(conv, identity.keyHash);
      if ((readRef.current[id] ?? 0) >= upTo) return;
      readRef.current = { ...readRef.current, [id]: upTo };
      setReadMarks(readRef.current);
      if (owner && cacheKey) saveMeta(owner, cacheKey, { cursor: savedCursor.current, read: readRef.current }).catch(() => {});
    },
    [identity, owner, cacheKey]
  );

  const storage = useMemo(
    () => ({ stats: storageStats(receivedMessages), retentionDays, setRetentionDays, clearFiles, clearConversation, clearAll, resync }),
    [receivedMessages, retentionDays, setRetentionDays, clearFiles, clearConversation, clearAll, resync]
  );

  return { messages, reactions, actions, conversations, loadBlobs, sendMessage, sendHistory, retrySend, cancelSend, storage, readMarks, markRead, cacheReady, loading, error };
}
