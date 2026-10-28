/**
 * Decrypted message format (Slack/Discord-like): sender, timestamp, optional group, type + body.
 * Used after decryption; server never sees this.
 */

export type DecryptedMessageBody =
  | { senderKeyHash: string; sentAt: number; recipientKeyHash?: string; type: "text"; body: string; groupMemberKeyHashes?: string[] }
  | { senderKeyHash: string; sentAt: number; recipientKeyHash?: string; type: "file"; body: string; filename?: string; fileSize?: number; groupMemberKeyHashes?: string[] }
  | { senderKeyHash: string; sentAt: number; recipientKeyHash?: string; type: "contact"; keyHash: string; publicKey: string; name?: string; groupMemberKeyHashes?: string[] }
  | { senderKeyHash: string; sentAt: number; type: "call_event"; event: "started" | "ended"; recipientKeyHash?: string; groupMemberKeyHashes?: string[] }
  | { senderKeyHash: string; sentAt: number; type: "group_rename"; newName: string; groupMemberKeyHashes: string[]; recipientKeyHash?: string };

/** Every message may carry the sender's token issuer key id, for the cross-check in tokens.ts. */
export type DecryptedMessage = DecryptedMessageBody & { issuer?: string };

export function encodeMessage(m: DecryptedMessage): string {
  return JSON.stringify(m);
}

export function decodeMessage(s: string): DecryptedMessage {
  return JSON.parse(s) as DecryptedMessage;
}

/** Fixed blob size (bytes). Server stores exactly this many bytes per blob. */
export const BLOB_SIZE = 65536;
/** Blob wire format: 2B senderLen + senderPubKey + 2B ciphertextLen + ciphertext + padding. */
export const CIPHERTEXT_MAX = BLOB_SIZE - 2 - 44 - 2; // 2+44+2 = header
/** Max plaintext per chunk (AES-GCM adds IV + tag). */
export const CHUNK_PLAIN_MAX = CIPHERTEXT_MAX - 28;

export type ChunkPlaintext = {
  messageId: string;
  chunkIndex: number;
  totalChunks: number;
  fragmentBase64: string;
};

export function chunkPayload(fullPayloadJson: string): ChunkPlaintext[] {
  const bytes = new TextEncoder().encode(fullPayloadJson);
  const chunks: ChunkPlaintext[] = [];
  const messageId = crypto.randomUUID();
  const totalChunks = Math.ceil(bytes.length / CHUNK_PLAIN_MAX);
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_PLAIN_MAX;
    const end = Math.min(start + CHUNK_PLAIN_MAX, bytes.length);
    const fragment = bytes.slice(start, end);
    const fragmentBase64 = btoa(String.fromCharCode.apply(null, Array.from(fragment)));
    chunks.push({ messageId, chunkIndex: i, totalChunks, fragmentBase64 });
  }
  return chunks;
}

export function reassemblePayload(chunks: ChunkPlaintext[]): string {
  if (chunks.length === 0) return "";
  chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
  const fragments = chunks.map((c) => {
    const bytes = Uint8Array.from(atob(c.fragmentBase64), (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  });
  return fragments.join("");
}

/** Packet version: 0 = legacy (no messageId), 1 = HKDF per-message + messageId in packet. */
const PACKET_VERSION_V1 = 1;

/** UUID string (36 chars) to 16 bytes (big-endian). */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error("Invalid UUID");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 16 bytes to UUID string. */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("Invalid UUID bytes");
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Build 65536-byte blob packet.
 * V1: [1B version][2B senderLen][sender][16B messageId][2B ciphertextLen][ciphertext][padding].
 */
export function buildBlobPacket(
  senderPublicKeyBase64: string,
  ciphertext: Uint8Array,
  messageId: string
): ArrayBuffer {
  const senderBytes = new TextEncoder().encode(senderPublicKeyBase64);
  const messageIdBytes = uuidToBytes(messageId);
  const packet = new ArrayBuffer(BLOB_SIZE);
  const view = new DataView(packet);
  const u8 = new Uint8Array(packet);
  let off = 0;
  u8[off++] = PACKET_VERSION_V1;
  view.setUint16(off, senderBytes.length, false);
  off += 2;
  u8.set(senderBytes, off);
  off += senderBytes.length;
  u8.set(messageIdBytes, off);
  off += 16;
  view.setUint16(off, ciphertext.length, false);
  off += 2;
  u8.set(ciphertext, off);
  return packet;
}

/**
 * Parse blob packet. Returns senderPublicKey, ciphertext, and optional messageId (V1 only).
 * Legacy packets (no version byte): [2B senderLen][sender][2B ctLen][ciphertext].
 */
export function parseBlobPacket(buffer: ArrayBuffer): {
  senderPublicKeyBase64: string;
  ciphertext: Uint8Array;
  messageId: string | null;
} {
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let off = 0;
  const isV1 = u8[0] === PACKET_VERSION_V1;
  if (isV1) off = 1;
  const senderLen = view.getUint16(off, false);
  off += 2;
  const senderPublicKeyBase64 = new TextDecoder().decode(u8.subarray(off, off + senderLen));
  off += senderLen;
  let messageId: string | null = null;
  if (isV1 && off + 16 <= u8.length) {
    messageId = bytesToUuid(u8.subarray(off, off + 16));
    off += 16;
  }
  const ciphertextLen = view.getUint16(off, false);
  off += 2;
  const ciphertext = u8.slice(off, off + ciphertextLen);
  return { senderPublicKeyBase64, ciphertext, messageId };
}

// Backward compat for e2ee (can remove when e2ee is unused)
export type BlobPayload = DecryptedMessage;
export const encodePayload = encodeMessage;
export const decodePayload = decodeMessage;
