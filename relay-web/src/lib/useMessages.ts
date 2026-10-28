"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { io } from "socket.io-client";
import { getBlobs, postBlobBinary } from "@/lib/api";
import {
  encryptMessageToBlobPackets,
  decryptBlobPacketToChunk,
  assembleVerifiedMessages,
  type DecryptedChunk,
} from "@/lib/blobChunk";
import type { DecryptedMessage } from "@/lib/blobPayload";
import type { Contact } from "@/lib/identityBinary";

const SOCKET_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/** No local persistence: all messages come from blobs (including our own via send-to-self). */

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
  const [error, setError] = useState<string | null>(null);

  const contactByKeyHash = new Map(identity?.contacts.map((c) => [c.keyHash, c]) ?? []);

  const messages = useMemo(() => {
    const list = [...receivedMessages];
    list.sort((a, b) => a.sentAt - b.sentAt);
    return list;
  }, [receivedMessages]);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, [identity]);

  // Fetch blobs only on initial load and when the server notifies us (socket "refresh"). No polling.
  useEffect(() => {
    if (!identity) return;
    loadBlobs();
    const socket = io(SOCKET_URL, { path: "/socket.io", transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      socket.emit("join_blob", identity.keyHash);
      loadBlobs();
    });
    socket.on("refresh", () => loadBlobs());
    return () => {
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
      for (const recipientKeyHash of recipientKeyHashes) {
        const contact = contactByKeyHash.get(recipientKeyHash);
        if (!contact) continue;
        const packets = await encryptMessageToBlobPackets(identity.keyPair, contact.publicKey, {
          ...fullMessage,
          recipientKeyHash: recipientKeyHashes.length === 1 ? recipientKeyHash : undefined,
        });
        for (const packet of packets) {
          await postBlobBinary(recipientKeyHash, packet);
        }
      }
      // Send a copy to self so we see it from blobs (no local persistence).
      const selfPackets = await encryptMessageToBlobPackets(identity.keyPair, identity.publicKeyBase64, fullMessage);
      for (const packet of selfPackets) {
        await postBlobBinary(identity.keyHash, packet);
      }
      await loadBlobs();
    },
    [identity, contactByKeyHash, loadBlobs]
  );

  return { messages, conversations, loadBlobs, sendMessage, error };
}
