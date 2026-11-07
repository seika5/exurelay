/**
 * Sealed profiles (DESIGN.md §4 "Names"): a member's display name, and for their own devices the names of those
 * devices, encrypted by one of the member's devices to each recipient device. The server stores the copies and can't
 * read them.
 *
 * Key: HKDF over the static ECDH secret between the sending and receiving devices (as for messages), with info
 * "exurelay-profile-v1:" + a random 16-byte nonce. Message keys use a bare 16-byte id as info, so the two never
 * collide. AES-GCM, with the author, sender, recipient and updatedAt as associated data, so the server can't move a
 * copy to another member or device or change its date. The plaintext is padded to one fixed size that fits the largest
 * profile picture, so a copy's length gives away neither the name's length nor whether there's a picture.
 */

import { isAvatarData } from "./avatar";
import { decrypt, deriveAesKeyFromEcdhHkdf, encrypt } from "./crypto";

export type ProfilePayload = {
  name: string;
  updatedAt: number;
  /** Only in copies to the author's own devices: names for their devices, by device key hash. */
  devices?: Record<string, string>;
  /**
   * Enrollment codes of members whose own name hasn't arrived yet, passed along by whoever enrolled them. Each is
   * signed by that member's key, so the name in it is theirs; receivers check that (signed.ts readIntroduction).
   */
  intros?: string[];
  /** The author's name signed with their signing key (a SignedEnvelope as JSON), so others can pass it along. */
  signed?: string;
  /** Other members' signed names (as `signed`), passed along so a new member gets everyone's name from whoever is online. */
  relay?: string[];
  /** The author's profile picture (avatar.ts), as a data URL. Absent: none. */
  avatar?: string;
};

/** A copy as posted: addressed to `recipient` (a device key hash). */
export type SealedCopy = { recipient: string; nonce: string; ciphertext: string; updatedAt: number };
/** A copy as received: from `author` (a member key hash), encrypted by their device `sender`. */
export type ReceivedCopy = { author: string; sender: string; nonce: string; ciphertext: string; updatedAt: number };

const INFO_PREFIX = new TextEncoder().encode("exurelay-profile-v1:");
/** Every copy's padded plaintext: room for a picture (about 11 KB as a data URL) and the rest. */
export const PADDED_SIZE = 16384;
/** A copy's JSON must stay within this, so it pads to PADDED_SIZE (the server takes ciphertexts up to 24576 base64 characters). */
export const COPY_BUDGET = PADDED_SIZE - 64;
/** The same for `compact` copies, within 4096 bytes. */
export const COMPACT_BUDGET = 4000;
/** Servers from before pictures take ciphertexts up to 8192 base64 characters: copies for them use the old sizes. */
const NAME_ONLY_SIZE = 1024;
const WITH_DEVICES_STEP = 2048;

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function info(nonce: Uint8Array): Uint8Array {
  const out = new Uint8Array(INFO_PREFIX.length + nonce.length);
  out.set(INFO_PREFIX);
  out.set(nonce, INFO_PREFIX.length);
  return out;
}

const aad = (author: string, sender: string, recipient: string, updatedAt: number) =>
  new TextEncoder().encode(`exurelay-profile-v1|${author}|${sender}|${recipient}|${updatedAt}`);

/**
 * JSON, then zero bytes up to PADDED_SIZE. `compact` (for a server from before pictures; the caller leaves the picture
 * out): up to 1024 bytes (name only) or the next multiple of 2048 (with device names, intros or relayed names).
 */
export function padPayload(p: ProfilePayload, compact = false): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(p));
  const size = !compact
    ? Math.max(PADDED_SIZE, json.length + 1)
    : p.devices || p.intros || p.relay
      ? Math.ceil((json.length + 1) / WITH_DEVICES_STEP) * WITH_DEVICES_STEP
      : Math.max(NAME_ONLY_SIZE, json.length + 1);
  const out = new Uint8Array(size);
  out.set(json);
  return out;
}

function unpad(bytes: Uint8Array): ProfilePayload | null {
  const end = bytes.indexOf(0);
  try {
    const p = JSON.parse(new TextDecoder().decode(end < 0 ? bytes : bytes.slice(0, end)));
    if (!p || typeof p.name !== "string" || !Number.isSafeInteger(p.updatedAt)) return null;
    if (p.devices !== undefined && (typeof p.devices !== "object" || Array.isArray(p.devices))) return null;
    if (p.intros !== undefined && (!Array.isArray(p.intros) || !p.intros.every((x: unknown) => typeof x === "string"))) return null;
    if (p.relay !== undefined && (!Array.isArray(p.relay) || !p.relay.every((x: unknown) => typeof x === "string"))) return null;
    if (p.signed !== undefined && typeof p.signed !== "string") return null;
    // A picture that isn't a small image data URL is dropped, not the whole copy.
    if (p.avatar !== undefined && !isAvatarData(p.avatar)) delete p.avatar;
    return p as ProfilePayload;
  } catch {
    return null;
  }
}

/** Seal `payload` from this device (`sender`, private key `myEcdh`) to `recipient` (public key `recipientEcdh`). */
export async function sealProfile(
  myEcdh: CryptoKey,
  recipientEcdh: CryptoKey,
  ids: { author: string; sender: string; recipient: string },
  payload: ProfilePayload,
  compact = false
): Promise<SealedCopy> {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveAesKeyFromEcdhHkdf(myEcdh, recipientEcdh, info(nonce));
  const ct = await encrypt(key, padPayload(payload, compact), aad(ids.author, ids.sender, ids.recipient, payload.updatedAt));
  return { recipient: ids.recipient, nonce: b64(nonce), ciphertext: b64(ct), updatedAt: payload.updatedAt };
}

/**
 * Open a copy addressed to this device (`me`, private key `myEcdh`). `senderEcdh` is the public key of the device
 * that sealed it; the caller must have checked that device belongs to `copy.author`. Null if it doesn't open.
 */
export async function openProfile(myEcdh: CryptoKey, senderEcdh: CryptoKey, me: string, copy: ReceivedCopy): Promise<ProfilePayload | null> {
  try {
    const key = await deriveAesKeyFromEcdhHkdf(myEcdh, senderEcdh, info(unb64(copy.nonce)));
    const plain = await decrypt(key, unb64(copy.ciphertext), aad(copy.author, copy.sender, me, copy.updatedAt));
    const p = unpad(plain);
    return p && p.updatedAt === copy.updatedAt ? p : null;
  } catch {
    return null;
  }
}
