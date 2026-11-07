/**
 * Sealed profiles (DESIGN.md §4 "Names"): a member's display name, and for their own devices the names of those
 * devices, encrypted by one of the member's devices to each recipient device. The server stores one copy per
 * (member, recipient device) and can't read any of them; it checks only who may write and who may read.
 */

import { createHash } from "node:crypto";

export const MAX_COPIES_PER_POST = 500;
// Copies are padded to one size that fits a profile picture (16 KB of plaintext, about 21.9K base64 characters).
// Older apps send copies of 8192 characters at most.
export const MAX_CIPHERTEXT_LENGTH = 24576;
const NONCE = /^[A-Za-z0-9+/]{22}==$/; // 16 bytes, base64
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_HASH = /^[0-9a-f]{64}$/;

/**
 * Check a batch of copies posted by a logged-in device. `session` is { keyHash, member } (the device and the member
 * it belongs to); `isRecipient(keyHash)` says whether a key hash is a current device of any current member.
 * Returns the rows to upsert, keyed by (author = the session's member, recipient).
 */
export function validateProfileCopies(body, session, isRecipient) {
  const copies = body?.copies;
  if (!Array.isArray(copies) || copies.length === 0) return { ok: false, error: "no copies" };
  if (copies.length > MAX_COPIES_PER_POST) return { ok: false, error: "too many copies" };
  const rows = [];
  const seen = new Set();
  for (const c of copies) {
    if (!c || typeof c !== "object") return { ok: false, error: "malformed copy" };
    const { recipient, nonce, ciphertext, updatedAt } = c;
    if (typeof recipient !== "string" || !KEY_HASH.test(recipient)) return { ok: false, error: "bad recipient" };
    if (recipient === session.keyHash) return { ok: false, error: "no copy for the sending device itself" };
    if (!isRecipient(recipient)) return { ok: false, error: "recipient isn't a current device" };
    if (seen.has(recipient)) return { ok: false, error: "duplicate recipient" };
    seen.add(recipient);
    if (typeof nonce !== "string" || !NONCE.test(nonce)) return { ok: false, error: "bad nonce" };
    if (typeof ciphertext !== "string" || !BASE64.test(ciphertext) || ciphertext.length > MAX_CIPHERTEXT_LENGTH) {
      return { ok: false, error: "bad ciphertext" };
    }
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) return { ok: false, error: "bad updatedAt" };
    rows.push({ author: session.member, recipient, sender: session.keyHash, nonce, ciphertext, updatedAt });
  }
  return { ok: true, rows };
}

/**
 * A short tag for the copies a device can read, from each copy's author, sender, nonce and date (a new copy always
 * has a new nonce). A device polls with the tag it last got and downloads the copies only when it differs.
 */
export function profilesTag(copies) {
  const lines = copies.map((c) => `${c.author}|${c.sender}|${c.nonce}|${c.updatedAt}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
}
