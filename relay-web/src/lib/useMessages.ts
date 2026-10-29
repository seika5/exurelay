"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ApiError, getBlobsSince, postBlobs } from "@/lib/api";
import { createSocket } from "@/lib/socket";
import { checkPeerIssuer, currentIssuerId, RateLimitError } from "@/lib/tokens";
import { decodeMessage, encodeMessage, type DecryptedMessage } from "@/lib/blobPayload";
import type { Contact } from "@/lib/keystore";
import { BATCH, Opener, sealSend, DEFAULT_BLOB_SIZE, DEFAULT_DECOYS, type Opened } from "@/lib/sealed";

/** Several "blobs" pings in a row (e.g. a multi-batch send) cost one sync. Each page fetched costs one token. */
const REFRESH_DEBOUNCE_MS = 1500;

/**
 * Protocol v2 (sealed.ts): every member downloads every blob once, from a cursor, and keeps what decrypts.
 * No local persistence yet (phase 5b): each launch syncs from the start of what the server holds, including our own
 * messages via the self-copy slot. Until our self-copy comes back, a message we sent is shown from the outbox:
 *
 * - "sending" (drawn faded): queued or in flight. The queue sends one message at a time, in order. Out of tokens
 *   (the server's rate limit), it waits until there are some and carries on; the messages just stay faded.
 * - "sent": the server has every blob; shown normally until our self-copy replaces it.
 * - "failed": the server refused it (any 4xx other than the rate limit), or it couldn't be reached for about a
 *   minute of retries. Shown with Retry and Cancel.
 */
export type OutboxStatus = "sending" | "sent" | "failed";
export type ShownMessage = DecryptedMessage & { outbox?: { id: string; status: OutboxStatus } };
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
  identity: { keyPair: CryptoKeyPair; keyHash: string; publicKeyBase64: string; contacts: Contact[] } | null,
  /** From the admin-signed directory (blobSettings in signed.ts). */
  blobs: { blobSize: number; decoys: number } = { blobSize: DEFAULT_BLOB_SIZE, decoys: DEFAULT_DECOYS }
) {
  const [receivedMessages, setReceivedMessages] = useState<DecryptedMessage[]>([]);
  // Sync state for this identity: where we are on the server, the trial decrypter, and what we've kept, by messageId.
  const cursor = useRef("0");
  const opener = useRef<Opener | null>(null);
  const received = useRef(new Map<string, DecryptedMessage>());
  const syncing = useRef<Promise<void> | null>(null);
  const syncAgain = useRef(false);
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
    const list: ShownMessage[] = [...receivedMessages];
    for (const o of outbox) {
      if (!receivedMessages.some((m) => outboxMatch(m, o.message))) list.push({ ...o.message, outbox: { id: o.id, status: o.status } });
    }
    list.sort((a, b) => a.sentAt - b.sentAt);
    return list;
  }, [receivedMessages, outbox]);

  /** Download every blob after our cursor and keep the messages that decrypt for us from a current member. */
  const syncOnce = useCallback(async () => {
    if (!identity) return;
    // Only contacts and ourselves can be senders: the opener tries each one's tag on every blob.
    const members = new Map(identity.contacts.map((c) => [c.keyHash, c.publicKey]));
    members.set(identity.keyHash, identity.publicKeyBase64);
    opener.current ??= new Opener(identity.keyPair, identity.keyHash);
    const fresh: DecryptedMessage[] = [];
    const keep = (opened: Opened) => {
      try {
        const msg = decodeMessage(new TextDecoder().decode(opened.payload));
        // The slot proved who sent it; the message must say the same.
        if (typeof msg.messageId !== "string" || msg.senderKeyHash !== opened.senderKeyHash) return;
        if (!received.current.has(msg.messageId)) {
          received.current.set(msg.messageId, msg);
          fresh.push(msg);
        }
      } catch {
        // Not a message we understand.
      }
    };
    // A member we've only just learned about may have sent something we already passed over.
    (await opener.current.setMembers(members)).forEach(keep);
    for (let more = true; more; ) {
      const page = await getBlobsSince(cursor.current);
      for (const b of page.blobs) {
        const opened = await opener.current.add(b);
        cursor.current = b.seq;
        if (opened) keep(opened);
      }
      more = page.more;
    }
    if (fresh.length === 0) return;
    const all = [...received.current.values()].sort((a, b) => a.sentAt - b.sentAt);
    setReceivedMessages(all);
    // Our self-copy is back: those messages no longer need the outbox.
    setOutbox((box) => box.filter((o) => o.status !== "sent" || !received.current.has(o.message.messageId)));
    // Cross-check the token keys other members are using (see tokens.ts).
    const issuers = new Set(fresh.filter((m) => m.senderKeyHash !== identity.keyHash && m.issuer).map((m) => m.issuer!));
    for (const id of issuers) checkPeerIssuer(id).catch(() => {});
  }, [identity, setOutbox]);

  /** One sync at a time; a ping during a sync runs one more afterwards. */
  const loadBlobs = useCallback(async () => {
    if (syncing.current) {
      syncAgain.current = true;
      return syncing.current;
    }
    setError(null);
    syncing.current = (async () => {
      try {
        do {
          syncAgain.current = false;
          await syncOnce();
        } while (syncAgain.current && alive.current);
      } catch (e) {
        // Out of tokens: sync again once there are some (from the same cursor).
        if (e instanceof RateLimitError) syncLater.current?.(e.retryAfter * 1000);
        else setError(e instanceof Error ? e.message : "Load failed");
      } finally {
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

  // A new member in the list: their recent sends may be among the blobs the opener couldn't place yet.
  const memberKey = identity?.contacts.map((c) => c.keyHash).sort().join(",");
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
          const recipients = recipientKeyHashes
            .map((k) => contactByKeyHash.get(k))
            .filter((c): c is Contact => !!c)
            .map((c) => ({ keyHash: c.keyHash, publicKey: c.publicKey }));
          const sealed = { ...fullMessage, issuer: await currentIssuerId() };
          // One encryption for everyone: a slot per recipient, plus one for our own key (the self-copy).
          prepared = await sealSend({
            senderKeyPair: identity.keyPair,
            senderKeyHash: identity.keyHash,
            recipients: [...recipients, { keyHash: identity.keyHash, publicKey: identity.publicKeyBase64 }],
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

  const retrySend = useCallback(
    (id: string) => {
      setStatus(id, "sending");
      drain();
    },
    [setStatus, drain]
  );
  const cancelSend = useCallback((id: string) => setOutbox((box) => box.filter((o) => o.id !== id)), [setOutbox]);

  // A different identity starts with an empty outbox and inbox, and syncs from the start.
  useEffect(() => {
    setOutbox(() => []);
    setReceivedMessages([]);
    cursor.current = "0";
    opener.current = null;
    received.current = new Map();
  }, [identity?.keyHash, setOutbox]);

  return { messages, conversations, loadBlobs, sendMessage, retrySend, cancelSend, error };
}
