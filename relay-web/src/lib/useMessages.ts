"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ApiError, getBlobs, postBlobs } from "@/lib/api";
import { createSocket } from "@/lib/socket";
import { checkPeerIssuer, currentIssuerId, RateLimitError } from "@/lib/tokens";
import {
  encryptMessageToBlobPackets,
  decryptBlobPacketToChunk,
  assembleVerifiedMessages,
  type DecryptedChunk,
} from "@/lib/blobChunk";
import type { DecryptedMessage } from "@/lib/blobPayload";
import type { Contact } from "@/lib/keystore";

/** Several "refresh" pings in a row (e.g. a multi-blob message) cost one sync, and so one token. */
const REFRESH_DEBOUNCE_MS = 1500;
/** Must not exceed the server's MAX_BLOBS_PER_POST (relay-server/src/routes/blob.js). */
const MAX_BLOBS_PER_POST = 64;

/**
 * No local persistence: all messages come from blobs (including our own via send-to-self). Until our self-copy
 * comes back, a message we sent is shown from the outbox:
 *
 * - "sending" (drawn faded): queued or in flight. The queue sends one message at a time, in order. Out of tokens
 *   (the server's rate limit), it waits until there are some and carries on; the messages just stay faded.
 * - "sent": the server has every blob; shown normally until our self-copy replaces it.
 * - "failed": the server refused it (any 4xx other than the rate limit), or it couldn't be reached for about a
 *   minute of retries. Shown with Retry and Discard.
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

const outboxMatch = (a: DecryptedMessage, b: DecryptedMessage) => a.senderKeyHash === b.senderKeyHash && a.sentAt === b.sentAt;

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
  identity: { keyPair: CryptoKeyPair; keyHash: string; publicKeyBase64: string; contacts: Contact[] } | null
) {
  const [receivedMessages, setReceivedMessages] = useState<DecryptedMessage[]>([]);
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

  const loadBlobs = useCallback(async () => {
    if (!identity) return;
    // Only contacts and ourselves; each message must be encrypted by the key its sender claims.
    const knownKeys = new Map(identity.contacts.map((c) => [c.keyHash, c.publicKey]));
    knownKeys.set(identity.keyHash, identity.publicKeyBase64);
    setError(null);
    try {
      const list = await getBlobs(identity.keyHash);
      const decrypted: DecryptedChunk[] = [];
      for (const b of list) {
        const buf = Uint8Array.from(atob(b.payload), (c) => c.charCodeAt(0)).buffer;
        const d = await decryptBlobPacketToChunk(identity.keyPair, buf);
        if (d) decrypted.push(d);
      }
      const out = assembleVerifiedMessages(decrypted, knownKeys);
      out.sort((a, b) => a.sentAt - b.sentAt);
      setReceivedMessages(out);
      // Our self-copy is back: those messages no longer need the outbox.
      setOutbox((box) => box.filter((o) => o.status !== "sent" || !out.some((m) => outboxMatch(m, o.message))));
      // Cross-check the token keys other members are using (see tokens.ts).
      const issuers = new Set(out.filter((m) => m.senderKeyHash !== identity.keyHash && m.issuer).map((m) => m.issuer!));
      for (const id of issuers) checkPeerIssuer(id).catch(() => {});
    } catch (e) {
      // Out of tokens: sync again once there are some.
      if (e instanceof RateLimitError) syncLater.current?.(e.retryAfter * 1000);
      else setError(e instanceof Error ? e.message : "Load failed");
    }
  }, [identity, setOutbox]);

  // Fetch blobs only on initial load and when the server notifies us (socket "refresh"). No polling.
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
    socket.on("connect", () => {
      socket.emit("join_blob", identity.keyHash);
      soon();
    });
    socket.on("refresh", () => soon());
    return () => {
      syncLater.current = null;
      if (timer) clearTimeout(timer);
      socket.emit("leave_blob", identity.keyHash);
      socket.close();
    };
  }, [identity?.keyHash, loadBlobs]);

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
            // The server's "refresh" ping for our self-copy reloads the conversation and clears this entry.
            setStatus(next.id, "sent");
            break;
          } catch (e) {
            const wait = retryDelay(e, e instanceof RateLimitError ? 0 : attempt++);
            if (wait === null) {
              setStatus(next.id, "failed");
              break;
            }
            await sleep(wait);
            // Discarded while we waited, or the chat went away.
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
      message: Omit<DecryptedMessage, "senderKeyHash" | "sentAt">,
      recipientKeyHashes: string[],
      options?: { recipientKeyHash?: string }
    ) => {
      if (!identity) return;
      const fullMessage = {
        ...message,
        senderKeyHash: identity.keyHash,
        sentAt: Date.now(),
        recipientKeyHash: options?.recipientKeyHash,
      } as DecryptedMessage;

      // Encrypted once, when its turn comes; a retry resumes with the first batch the server didn't take.
      let prepared: { to: string[]; blobs: ArrayBuffer[] } | null = null;
      let posted = 0;
      const post = async () => {
        if (!prepared) {
          const sealed = { ...fullMessage, issuer: await currentIssuerId() };
          // Every recipient's blobs plus our self-copy go up together, in batches, one token per request.
          const to: string[] = [];
          const blobs: ArrayBuffer[] = [];
          for (const recipientKeyHash of recipientKeyHashes) {
            const contact = contactByKeyHash.get(recipientKeyHash);
            if (!contact) continue;
            const packets = await encryptMessageToBlobPackets(identity.keyPair, contact.publicKey, {
              ...sealed,
              recipientKeyHash: recipientKeyHashes.length === 1 ? recipientKeyHash : undefined,
            });
            for (const packet of packets) {
              to.push(recipientKeyHash);
              blobs.push(packet);
            }
          }
          // A copy to self so we see it from blobs (no local persistence).
          for (const packet of await encryptMessageToBlobPackets(identity.keyPair, identity.publicKeyBase64, sealed)) {
            to.push(identity.keyHash);
            blobs.push(packet);
          }
          prepared = { to, blobs };
        }
        for (; posted < prepared.blobs.length; posted += MAX_BLOBS_PER_POST) {
          await postBlobs(prepared.to.slice(posted, posted + MAX_BLOBS_PER_POST), prepared.blobs.slice(posted, posted + MAX_BLOBS_PER_POST));
        }
      };
      setOutbox((box) => [...box, { id: crypto.randomUUID(), message: fullMessage, status: "sending", post }]);
      drain();
    },
    [identity, contactByKeyHash, setOutbox, drain]
  );

  const retrySend = useCallback(
    (id: string) => {
      setStatus(id, "sending");
      drain();
    },
    [setStatus, drain]
  );
  const discardSend = useCallback((id: string) => setOutbox((box) => box.filter((o) => o.id !== id)), [setOutbox]);

  // A different identity starts with an empty outbox and inbox.
  useEffect(() => {
    setOutbox(() => []);
    setReceivedMessages([]);
  }, [identity?.keyHash, setOutbox]);

  return { messages, conversations, loadBlobs, sendMessage, retrySend, discardSend, error };
}
