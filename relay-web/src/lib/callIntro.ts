/**
 * Call intros (DESIGN.md §7). Call sockets don't log in, so the server can't say who is behind one; each peer says so
 * itself, to every other socket in the room. An intro is signed by the device's signing key over the room, the
 * sender's socket id and the time, then sealed with a key from the room secret, which travels only inside the
 * encrypted "call started" message. A peer counts as a participant only once its intro opens, is fresh, names this
 * room and its own socket, and verifies against a current device of a member of the conversation.
 */

import { signRecord, verifyRecord, type SignedEnvelope } from "./signed";

/** Intros older or newer than this are refused (replays, broken clocks). */
export const INTRO_MAX_SKEW_MS = 2 * 60_000;

export type IntroIdentity = { member: string; device: string };
type IntroRecord = { type: "relay-call-intro"; room: string; socket: string; member: string; device: string; ts: number };

const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

/** 32 random bytes, base64url. */
export function newRoomKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export const isRoomKey = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);

/** The AES key every peer in this call seals its intro with. */
export async function introKey(roomKey: string, roomId: string): Promise<CryptoKey> {
  const hkdf = await crypto.subtle.importKey("raw", unb64url(roomKey) as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(roomId), info: enc.encode("relay-call-intro") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function sealIntro(
  key: CryptoKey,
  signingKey: CryptoKey,
  who: { roomId: string; socket: string; member: string; device: string },
  now = Date.now()
): Promise<string> {
  const record: IntroRecord = { type: "relay-call-intro", room: who.roomId, socket: who.socket, member: who.member, device: who.device, ts: now };
  const env = await signRecord(signingKey, record);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(who.roomId) }, key, enc.encode(JSON.stringify(env)))
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

/**
 * Who sent this intro, or null if it doesn't open with this room's key, is stale, names another room or socket, or
 * isn't signed by the device it names. signerFor gives that device's signing public key only if it's a current
 * device of a member allowed in this call.
 */
export async function openIntro(
  key: CryptoKey,
  sealed: string,
  ctx: { roomId: string; from: string; signerFor: (member: string, device: string) => string | undefined; now?: number }
): Promise<IntroIdentity | null> {
  try {
    const raw = unb64(sealed);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(ctx.roomId) }, key, raw.slice(12));
    const env = JSON.parse(new TextDecoder().decode(pt)) as SignedEnvelope;
    if (typeof env?.body !== "string" || typeof env.signature !== "string") return null;
    const r = JSON.parse(env.body) as IntroRecord;
    if (r?.type !== "relay-call-intro" || r.room !== ctx.roomId || r.socket !== ctx.from) return null;
    if (typeof r.member !== "string" || typeof r.device !== "string" || typeof r.ts !== "number") return null;
    if (Math.abs((ctx.now ?? Date.now()) - r.ts) > INTRO_MAX_SKEW_MS) return null;
    const signer = ctx.signerFor(r.member, r.device);
    if (!signer || !(await verifyRecord(env, signer))) return null;
    return { member: r.member, device: r.device };
  } catch {
    return null;
  }
}
