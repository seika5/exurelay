/**
 * Chunked blob encrypt/decrypt: build DecryptedMessage -> chunk -> encrypt each -> 65536-byte packets;
 * receive packets -> decrypt -> ChunkPlaintext -> reassemble -> DecryptedMessage.
 */

import { importPublicKey, deriveAesKey, deriveAesKeyFromEcdhHkdf, encrypt, decrypt } from "./crypto";
import { exportPublicKey } from "./e2ee";
import {
  type DecryptedMessage,
  encodeMessage,
  decodeMessage,
  chunkPayload,
  reassemblePayload,
  buildBlobPacket,
  parseBlobPacket,
  uuidToBytes,
  type ChunkPlaintext,
  BLOB_SIZE,
} from "./blobPayload";

/** Encrypt a message for one recipient; returns one or more blob packets (each BLOB_SIZE bytes). */
export async function encryptMessageToBlobPackets(
  myKeyPair: CryptoKeyPair,
  recipientPublicKeyBase64: string,
  message: DecryptedMessage
): Promise<ArrayBuffer[]> {
  const fullJson = encodeMessage(message);
  const chunks = chunkPayload(fullJson);
  const messageId = chunks[0].messageId;
  const theirPublic = await importPublicKey(recipientPublicKeyBase64);
  const info = uuidToBytes(messageId);
  const sharedKey = await deriveAesKeyFromEcdhHkdf(myKeyPair.privateKey, theirPublic, info);
  const senderPublicKey = await exportPublicKey(myKeyPair.publicKey);
  const packets: ArrayBuffer[] = [];
  for (const chunk of chunks) {
    const plain = new TextEncoder().encode(JSON.stringify(chunk));
    const ciphertext = await encrypt(sharedKey, plain, info);
    const packet = buildBlobPacket(senderPublicKey, ciphertext, messageId);
    if (packet.byteLength !== BLOB_SIZE) throw new Error("Blob packet wrong size");
    packets.push(packet);
  }
  return packets;
}

/** A decrypted chunk plus the public key that actually encrypted it (proven by AES-GCM auth). */
export type DecryptedChunk = { chunk: ChunkPlaintext; senderPublicKeyBase64: string };

/** Decrypt one blob packet; returns the chunk and its real sender key, or null if decrypt fails. */
export async function decryptBlobPacketToChunk(
  myKeyPair: CryptoKeyPair,
  packet: ArrayBuffer
): Promise<DecryptedChunk | null> {
  try {
    const { senderPublicKeyBase64, ciphertext, messageId } = parseBlobPacket(packet);
    const senderPublic = await importPublicKey(senderPublicKeyBase64);
    const sharedKey =
      messageId != null
        ? await deriveAesKeyFromEcdhHkdf(myKeyPair.privateKey, senderPublic, uuidToBytes(messageId))
        : await deriveAesKey(myKeyPair.privateKey, senderPublic);
    const aad = messageId != null ? uuidToBytes(messageId) : undefined;
    const plain = await decrypt(sharedKey, ciphertext, aad);
    const chunk = JSON.parse(new TextDecoder().decode(plain)) as ChunkPlaintext;
    if (typeof chunk.messageId !== "string" || typeof chunk.chunkIndex !== "number" || typeof chunk.totalChunks !== "number" || typeof chunk.fragmentBase64 !== "string") {
      return null;
    }
    // The packet header's messageId is bound as AAD; the inner one must match it.
    if (messageId != null && chunk.messageId !== messageId) return null;
    return { chunk, senderPublicKeyBase64 };
  } catch {
    return null;
  }
}

/**
 * Reassemble decrypted chunks into messages, keeping only messages whose claimed senderKeyHash
 * maps (in knownKeys: keyHash -> publicKey base64) to the key that actually encrypted them.
 * Without this check anyone could forge a message that appears to come from any contact.
 */
export function assembleVerifiedMessages(
  decrypted: DecryptedChunk[],
  knownKeys: Map<string, string>
): DecryptedMessage[] {
  const groups = new Map<string, DecryptedChunk[]>();
  for (const d of decrypted) {
    // Group by sender too, so one sender can't inject chunks into another sender's message.
    const id = `${d.senderPublicKeyBase64}|${d.chunk.messageId}`;
    const arr = groups.get(id) ?? [];
    arr.push(d);
    groups.set(id, arr);
  }
  const out: DecryptedMessage[] = [];
  for (const group of groups.values()) {
    const msg = reassembleChunksToMessage(group.map((d) => d.chunk));
    if (!msg) continue;
    const expectedKey = knownKeys.get(msg.senderKeyHash);
    if (expectedKey && expectedKey === group[0].senderPublicKeyBase64) out.push(msg);
  }
  return out;
}

/** Reassemble chunks (same messageId) into one DecryptedMessage. */
export function reassembleChunksToMessage(chunks: ChunkPlaintext[]): DecryptedMessage | null {
  if (chunks.length === 0) return null;
  try {
    const fullJson = reassemblePayload(chunks);
    return decodeMessage(fullJson);
  } catch {
    return null;
  }
}
