/**
 * Protocol v2 (DESIGN.md §5 "As built (phase 5a)"): sealed sender, recipient-blind, fixed-size blobs that are all
 * indistinguishable from random bytes.
 *
 * A send is encrypted once under a random message key and spread over blobs of exactly `blobSize` bytes:
 *
 *   head:         nonce (32 B random) ‖ N slots (104 B each, random order) ‖ body…
 *   continuation: tag_j (16 B) ‖ body…
 *   decoy:        random bytes
 *
 * slot = tag (16 B) ‖ AES-GCM(kek, messageKey 32 ‖ bodyLength u32 ‖ bodyStart u32 ‖ SHA-256(body) 32), where
 * tag ‖ kek = HKDF(ECDH(sender, recipient), salt = nonce, info = sender keyHash ‖ recipient keyHash). Only the sender
 * and that recipient know that static ECDH secret, so a matching slot both finds the recipient's copy and proves who
 * sent it, without a signature anyone else could check (deniable). The secret is the same in both directions, so
 * the info names the direction: otherwise a sender reading their own self-copy would match the slot they made for
 * someone else and think that person sent it. The body hash in the slot stops another recipient, who also knows the message key, from
 * swapping the body. Continuation tags come from the message key, so only recipients can tell which blobs belong to
 * which send. Nothing in any blob is a public key or other structure, so heads, continuations and decoys all look
 * alike, and the head goes anywhere in the first upload batch.
 */

import { importPublicKey } from "./crypto";

export const DEFAULT_BLOB_SIZE = 65536;
export const MIN_BLOB_SIZE = 16384;
export const MAX_BLOB_SIZE = 262144;
export const DEFAULT_DECOYS = 3;
export const MAX_DECOYS = 16;
/** Must not exceed the server's MAX_BLOBS_PER_POST: the head is placed at random within the first batch. */
export const BATCH = 64;

const NONCE_LEN = 32;
const TAG_LEN = 16;
const SLOT_PLAIN = 32 + 4 + 4 + 32;
export const SLOT_LEN = TAG_LEN + SLOT_PLAIN + 16;
/** Unmatched blobs kept for a later head or member list: a batch, plus headroom. */
const WINDOW = 2 * BATCH;
const ZERO_IV = new Uint8Array(12); // every AES key below encrypts exactly once
const enc = new TextEncoder();

/** Most recipients (yourself included) one send can have at this blob size. */
export const maxRecipients = (blobSize: number) => Math.floor((blobSize - NONCE_LEN) / SLOT_LEN);

const subtle = () => crypto.subtle;
const bs = (b: Uint8Array) => b as BufferSource;

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
  return out;
}

function randomInt(maxInclusive: number): number {
  return maxInclusive <= 0 ? 0 : crypto.getRandomValues(new Uint32Array(1))[0] % (maxInclusive + 1);
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The static ECDH secret with another member (or yourself, for the self-copy). */
async function staticSecret(myPrivate: CryptoKey, theirPublicBase64: string): Promise<Uint8Array> {
  return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: await importPublicKey(theirPublicBase64) }, myPrivate, 256));
}

/** A slot's tag (to find it) and key-encryption key, for one sender → recipient direction and one send. */
async function slotKeys(secret: Uint8Array, nonce: Uint8Array, sender: string, recipient: string): Promise<{ tag: Uint8Array; kek: CryptoKey }> {
  const k = await subtle().importKey("raw", bs(secret), "HKDF", false, ["deriveBits"]);
  const info = enc.encode(`relay-v2-slot|${sender}|${recipient}`);
  const m = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: bs(nonce), info }, k, (TAG_LEN + 32) * 8));
  return { tag: m.slice(0, TAG_LEN), kek: await aesKey(m.slice(TAG_LEN)) };
}

const aesKey = (raw: Uint8Array) => subtle().importKey("raw", bs(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
const aesEncrypt = async (key: CryptoKey, data: Uint8Array, aad: Uint8Array) =>
  new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: ZERO_IV, additionalData: bs(aad) }, key, bs(data)));
const aesDecrypt = async (key: CryptoKey, data: Uint8Array, aad: Uint8Array) =>
  new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: ZERO_IV, additionalData: bs(aad) }, key, bs(data)));
const sha256 = async (b: Uint8Array) => new Uint8Array(await subtle().digest("SHA-256", bs(b)));

async function continuationTag(messageKey: Uint8Array, j: number): Promise<Uint8Array> {
  const data = new Uint8Array(32 + 4 + 13);
  data.set(messageKey);
  new DataView(data.buffer).setUint32(32, j);
  data.set(enc.encode("relay-v2-cont"), 36);
  return (await sha256(data)).slice(0, TAG_LEN);
}

const constantEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.reduce((d, x, i) => d | (x ^ b[i]), 0) === 0;

export type SealInput = {
  senderKeyPair: CryptoKeyPair;
  senderKeyHash: string;
  /** Recipients (keyHash + base64 raw ECDH public key); include yourself for the self-copy. */
  recipients: { keyHash: string; publicKey: string }[];
  payload: Uint8Array;
  blobSize: number;
  /** Up to this many decoy blobs, chosen at random per send. */
  maxDecoys: number;
};

/** Encrypt a send. Returns the blobs in upload order: everything shuffled, with the head somewhere in the first batch. */
export async function sealSend(input: SealInput): Promise<Uint8Array[]> {
  const S = input.blobSize;
  const recipients = [...new Map(input.recipients.map((r) => [r.keyHash, r])).values()];
  if (recipients.length === 0) throw new Error("No recipients");
  if (recipients.length > maxRecipients(S)) throw new Error(`Too many recipients for one send (max ${maxRecipients(S)})`);

  const nonce = randomBytes(NONCE_LEN);
  const messageKeyRaw = randomBytes(32);
  const body = await aesEncrypt(await aesKey(messageKeyRaw), input.payload, nonce);
  const digest = await sha256(body);

  const bodyStart = NONCE_LEN + recipients.length * SLOT_LEN;
  const slots: Uint8Array[] = [];
  for (const r of recipients) {
    const { tag, kek } = await slotKeys(await staticSecret(input.senderKeyPair.privateKey, r.publicKey), nonce, input.senderKeyHash, r.keyHash);
    const pt = new Uint8Array(SLOT_PLAIN);
    pt.set(messageKeyRaw);
    const v = new DataView(pt.buffer);
    v.setUint32(32, body.length);
    v.setUint32(36, bodyStart);
    pt.set(digest, 40);
    const slot = new Uint8Array(SLOT_LEN);
    slot.set(tag);
    slot.set(await aesEncrypt(kek, pt, tag), TAG_LEN);
    slots.push(slot);
  }
  shuffle(slots);

  const head = randomBytes(S);
  head.set(nonce);
  slots.forEach((s, i) => head.set(s, NONCE_LEN + i * SLOT_LEN));
  let used = Math.min(body.length, S - bodyStart);
  head.set(body.subarray(0, used), bodyStart);

  const rest: Uint8Array[] = [];
  for (let j = 1; used < body.length; j++) {
    const blob = randomBytes(S);
    blob.set(await continuationTag(messageKeyRaw, j));
    const n = Math.min(body.length - used, S - TAG_LEN);
    blob.set(body.subarray(used, used + n), TAG_LEN);
    used += n;
    rest.push(blob);
  }
  for (let d = randomInt(Math.min(input.maxDecoys, MAX_DECOYS)); d > 0; d--) rest.push(randomBytes(S));
  shuffle(rest);
  // The head anywhere in the first batch: recipients keep that much unmatched traffic around (Opener's window).
  rest.splice(randomInt(Math.min(rest.length, BATCH - 1)), 0, head);
  return rest;
}

export type StoredBlob = { seq: string; expiresAt: number; payload: Uint8Array };
export type Opened = { seq: string; expiresAt: number; senderKeyHash: string; payload: Uint8Array };

type Pending = {
  seq: string;
  expiresAt: number;
  senderKeyHash: string;
  nonce: Uint8Array;
  messageKey: Uint8Array;
  bodyLength: number;
  digest: Uint8Array;
  parts: (Uint8Array | null)[];
  tags: string[];
};

/**
 * Feeds every downloaded blob through trial decryption, in seq order. For each blob it computes the tag every
 * member would have used for us and looks for it among the slot positions (one small hash per member per blob).
 * Keeps a window of recent unmatched blobs, because a send's head may come after some of its continuations in the
 * same batch, and a new member's message may arrive before our member list has them.
 */
export class Opener {
  private secrets = new Map<string, Uint8Array>(); // keyHash -> static ECDH secret with us
  private pending = new Map<string, { p: Pending; index: number }>(); // continuation tag -> waiting send
  private window: StoredBlob[] = [];

  constructor(private keyPair: CryptoKeyPair, private keyHash: string) {}

  /** The current members (keyHash -> ECDH public key), ourselves included. New ones get a look at the window. */
  async setMembers(members: Map<string, string>): Promise<Opened[]> {
    const added = new Map<string, Uint8Array>();
    for (const [keyHash, pub] of members) {
      if (this.secrets.has(keyHash)) continue;
      const s = await staticSecret(this.keyPair.privateKey, pub);
      this.secrets.set(keyHash, s);
      added.set(keyHash, s);
    }
    for (const k of [...this.secrets.keys()]) if (!members.has(k)) this.secrets.delete(k);
    if (added.size === 0) return [];
    const out: Opened[] = [];
    for (const b of [...this.window]) {
      const o = await this.tryHead(b, added);
      if (o) out.push(o);
    }
    return out;
  }

  async add(blob: StoredBlob): Promise<Opened | null> {
    const fromPending = this.continue(blob);
    if (fromPending !== undefined) return fromPending;
    this.dropExpired();
    const opened = await this.tryHead(blob, this.secrets);
    if (opened !== undefined) return opened;
    this.window.push(blob);
    if (this.window.length > WINDOW) this.window.shift();
    return null;
  }

  /** A continuation of a send we're waiting on: undefined if it isn't one. */
  private continue(blob: StoredBlob): Promise<Opened | null> | undefined {
    const waiting = this.pending.get(hex(blob.payload.subarray(0, TAG_LEN)));
    if (!waiting) return undefined;
    const { p, index } = waiting;
    p.parts[index] = blob.payload.subarray(TAG_LEN);
    this.pending.delete(p.tags[index - 1]);
    this.window = this.window.filter((b) => b !== blob);
    return p.parts.every(Boolean) ? this.finish(p) : Promise.resolve(null);
  }

  private dropExpired() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.p.expiresAt < now) this.pending.delete(k);
  }

  /** Our slot from one of these senders: the opened send, null if it's ours but still incomplete, undefined if not ours. */
  private async tryHead(blob: StoredBlob, senders: Map<string, Uint8Array>): Promise<Opened | null | undefined> {
    const b = blob.payload;
    const nonce = b.subarray(0, NONCE_LEN);
    const byTag = new Map<string, { keyHash: string; kek: CryptoKey }>();
    for (const [keyHash, secret] of senders) {
      const { tag, kek } = await slotKeys(secret, nonce, keyHash, this.keyHash);
      byTag.set(hex(tag), { keyHash, kek });
    }
    for (let off = NONCE_LEN; off + SLOT_LEN <= b.length; off += SLOT_LEN) {
      const tag = b.subarray(off, off + TAG_LEN);
      const hit = byTag.get(hex(tag));
      if (!hit) continue;
      let pt: Uint8Array;
      try {
        pt = await aesDecrypt(hit.kek, b.subarray(off + TAG_LEN, off + SLOT_LEN), tag);
      } catch {
        continue;
      }
      const v = new DataView(pt.buffer, pt.byteOffset);
      const bodyLength = v.getUint32(32);
      const bodyStart = v.getUint32(36);
      if (bodyStart < NONCE_LEN || bodyStart > b.length) return undefined;
      const first = b.subarray(bodyStart, Math.min(b.length, bodyStart + bodyLength));
      const more = Math.ceil(Math.max(0, bodyLength - first.length) / (b.length - TAG_LEN));
      const p: Pending = {
        seq: blob.seq,
        expiresAt: blob.expiresAt,
        senderKeyHash: hit.keyHash,
        nonce: nonce.slice(),
        messageKey: pt.slice(0, 32),
        bodyLength,
        digest: pt.slice(40, 72),
        parts: [first, ...Array(more).fill(null)],
        tags: [],
      };
      this.window = this.window.filter((w) => w !== blob);
      for (let j = 1; j <= more; j++) {
        const t = hex(await continuationTag(p.messageKey, j));
        p.tags.push(t);
        this.pending.set(t, { p, index: j });
      }
      if (more === 0) return this.finish(p);
      // Continuations that came before the head (same batch) are already in the window.
      for (const w of [...this.window]) {
        const done = this.continue(w);
        if (done) {
          const o = await done;
          if (o) return o;
        }
      }
      return null;
    }
    return undefined;
  }

  private async finish(p: Pending): Promise<Opened | null> {
    const body = new Uint8Array(p.bodyLength);
    let o = 0;
    for (const part of p.parts) {
      const n = Math.min(part!.length, p.bodyLength - o);
      body.set(part!.subarray(0, n), o);
      o += n;
    }
    try {
      if (!constantEq(await sha256(body), p.digest)) return null;
      const payload = await aesDecrypt(await aesKey(p.messageKey), body, p.nonce);
      return { seq: p.seq, expiresAt: p.expiresAt, senderKeyHash: p.senderKeyHash, payload };
    } catch {
      return null;
    }
  }
}
