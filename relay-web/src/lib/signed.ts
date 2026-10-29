/**
 * Signed records: { body, signature }, where body is the exact JSON string that was signed, so verifiers
 * never re-serialize. ECDSA P-256 / SHA-256, raw (r||s) signatures, base64. Must match relay-server/src/lib/signed.js.
 *
 * Three record types:
 * - Enrollment code (newcomer → admin, in person): the newcomer's keys + chosen name, valid 3 minutes.
 * - Directory (admin-signed): every member's keys, removed members, and who the admins are. Version only goes up.
 * - Profile (member-signed): a member's display name.
 */

import { exportPublicKey, importSigningPublicKey, sha256Hex } from "./crypto";
import { DEFAULT_BLOB_SIZE, DEFAULT_DECOYS, MAX_BLOB_SIZE, MAX_DECOYS, MIN_BLOB_SIZE } from "./sealed";

export type SignedEnvelope = { body: string; signature: string };

export type DirectoryMember = {
  keyHash: string;
  /** ECDH public key (base64 raw) used for encryption. */
  ecdh: string;
  /** ECDSA public key (base64 raw) used for this member's signatures. */
  sig: string;
  enrolledAt: number;
  /** keyHash of this member's previous key when they re-enrolled (lost device). */
  replaces?: string;
};

export type Directory = {
  type: "relay-directory";
  version: number;
  issuedAt: number;
  signer: string;
  members: DirectoryMember[];
  removed: { keyHash: string; removedAt: number }[];
  /** Signing keys of the admins trusted for the next version. Clients re-pin to this list. */
  admins?: string[];
  /** Admin settings for protocol v2 blobs (sealed.ts): every blob's size in bytes, and the most decoys per send. */
  blobSize?: number;
  decoys?: number;
};

/** The directory's blob settings, or the defaults where it doesn't set them (or sets something out of range). */
export function blobSettings(d: Directory | null): { blobSize: number; decoys: number } {
  const size = d?.blobSize;
  const decoys = d?.decoys;
  return {
    blobSize:
      typeof size === "number" && Number.isInteger(size) && size % 1024 === 0 && size >= MIN_BLOB_SIZE && size <= MAX_BLOB_SIZE
        ? size
        : DEFAULT_BLOB_SIZE,
    decoys: typeof decoys === "number" && Number.isInteger(decoys) && decoys >= 0 && decoys <= MAX_DECOYS ? decoys : DEFAULT_DECOYS,
  };
}

export type Profile = { type: "relay-profile"; keyHash: string; name: string; updatedAt: number };

/** A member's own signed notice that they left a server. */
export type Leave = { type: "relay-leave"; keyHash: string; server: string; ts: number };

export type EnrollmentRequest = { type: "relay-enroll"; ecdh: string; sig: string; name: string; ts: number };

export const ENROLLMENT_CODE_TTL_MS = 3 * 60 * 1000;
export const MAX_NAME_LENGTH = 64;
const ENROLL_PREFIX = "RELAY-ENROLL:";

const toB64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...Array.from(new Uint8Array(buf))));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Same scheme as message addressing: SHA-256 hex of the base64 ECDH public key. */
export const keyHashOf = (ecdhPublicKeyBase64: string) => sha256Hex(ecdhPublicKeyBase64);

export async function signRecord(privateKey: CryptoKey, record: object): Promise<SignedEnvelope> {
  const body = JSON.stringify(record);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(body));
  return { body, signature: toB64(sig) };
}

export async function verifyRecord(envelope: SignedEnvelope, signingPublicKeyBase64: string): Promise<boolean> {
  try {
    const key = await importSigningPublicKey(signingPublicKeyBase64);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromB64(envelope.signature) as BufferSource,
      new TextEncoder().encode(envelope.body)
    );
  } catch {
    return false;
  }
}

function parse<T>(envelope: SignedEnvelope): T | null {
  try {
    return JSON.parse(envelope.body) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enrollment codes
// ---------------------------------------------------------------------------

export async function createEnrollmentCode(
  ecdhPublicKey: CryptoKey,
  signingKeyPair: CryptoKeyPair,
  name: string,
  now = Date.now()
): Promise<string> {
  const request: EnrollmentRequest = {
    type: "relay-enroll",
    ecdh: await exportPublicKey(ecdhPublicKey),
    sig: await exportPublicKey(signingKeyPair.publicKey),
    name: name.trim().slice(0, MAX_NAME_LENGTH),
    ts: now,
  };
  const env = await signRecord(signingKeyPair.privateKey, request);
  return ENROLL_PREFIX + btoa(JSON.stringify(env));
}

/** Decode and check an enrollment code: signed by the key it carries, and less than 3 minutes old. */
export async function readEnrollmentCode(
  code: string,
  now = Date.now()
): Promise<{ ok: true; request: EnrollmentRequest; keyHash: string } | { ok: false; error: string }> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(ENROLL_PREFIX)) return { ok: false, error: "Not a Relay enrollment code." };
  let env: SignedEnvelope;
  try {
    env = JSON.parse(atob(trimmed.slice(ENROLL_PREFIX.length)));
  } catch {
    return { ok: false, error: "The code is damaged. Copy it again." };
  }
  const req = parse<EnrollmentRequest>(env);
  if (!req || req.type !== "relay-enroll" || typeof req.ecdh !== "string" || typeof req.sig !== "string") {
    return { ok: false, error: "The code is damaged. Copy it again." };
  }
  if (!(await verifyRecord(env, req.sig))) return { ok: false, error: "The code's signature is invalid." };
  if (typeof req.ts !== "number" || now - req.ts > ENROLLMENT_CODE_TTL_MS || req.ts - now > 30_000) {
    return { ok: false, error: "The code has expired (codes last 3 minutes). Ask for a fresh one." };
  }
  return { ok: true, request: req, keyHash: await keyHashOf(req.ecdh) };
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

/**
 * Verify a directory against the admin keys this device has pinned for the server. minVersion is the newest
 * version this device has already accepted: anything older is refused, so a server can't replay a pre-removal
 * list. On success the caller re-pins to directory.admins (when present).
 */
export async function verifyDirectory(
  envelope: SignedEnvelope,
  adminKeys: string[],
  minVersion: number
): Promise<{ ok: true; directory: Directory } | { ok: false; error: string }> {
  const d = parse<Directory>(envelope);
  if (!d || d.type !== "relay-directory" || !Array.isArray(d.members) || !Array.isArray(d.removed)) {
    return { ok: false, error: "The member list from the server is malformed." };
  }
  if (d.admins != null && (!Array.isArray(d.admins) || d.admins.length === 0 || !d.admins.every((a) => typeof a === "string"))) {
    return { ok: false, error: "The member list from the server is malformed." };
  }
  if (!adminKeys.includes(d.signer) || !(await verifyRecord(envelope, d.signer))) {
    return { ok: false, error: "The member list isn't signed by an admin this app trusts." };
  }
  if (!Number.isSafeInteger(d.version) || d.version < minVersion) {
    return { ok: false, error: `The server sent an older member list (v${d.version}; this device has seen v${minVersion}).` };
  }
  for (const m of d.members) {
    if (m.keyHash !== (await keyHashOf(m.ecdh))) return { ok: false, error: "A member's key doesn't match its id." };
  }
  return { ok: true, directory: d };
}

/** Verified display names by keyHash. Profiles not signed by the member's directory key are ignored. */
export async function verifyProfiles(profiles: SignedEnvelope[], members: DirectoryMember[]): Promise<Map<string, Profile>> {
  const byHash = new Map(members.map((m) => [m.keyHash, m]));
  const out = new Map<string, Profile>();
  for (const env of profiles) {
    const p = parse<Profile>(env);
    const m = p && byHash.get(p.keyHash);
    if (!p || !m || p.type !== "relay-profile" || typeof p.name !== "string") continue;
    if (!(await verifyRecord(env, m.sig))) continue;
    const prev = out.get(p.keyHash);
    if (!prev || p.updatedAt > prev.updatedAt) out.set(p.keyHash, { ...p, name: p.name.slice(0, MAX_NAME_LENGTH) });
  }
  return out;
}

/**
 * Members who signed their own leave, by keyHash. Only leaves signed by the member's directory key count, so the
 * server can't make someone vanish from your contacts.
 */
export async function verifyDepartures(departures: SignedEnvelope[], members: DirectoryMember[]): Promise<Set<string>> {
  const byHash = new Map(members.map((m) => [m.keyHash, m]));
  const out = new Set<string>();
  for (const env of departures) {
    const l = parse<Leave>(env);
    const m = l && byHash.get(l.keyHash);
    if (!l || !m || l.type !== "relay-leave") continue;
    if (await verifyRecord(env, m.sig)) out.add(l.keyHash);
  }
  return out;
}

/** Next directory version with a newcomer added. With replaces, the old key is moved to removed. */
export function directoryWithMember(
  current: Directory | null,
  signer: string,
  member: DirectoryMember,
  now = Date.now()
): Directory {
  const members = (current?.members ?? []).filter((m) => m.keyHash !== member.keyHash && m.keyHash !== member.replaces);
  // A re-enrolled admin stays an admin under their new key.
  const oldSig = current?.members.find((m) => m.keyHash === member.replaces)?.sig;
  const admins = (current?.admins ?? [signer]).map((a) => (a === oldSig ? member.sig : a));
  const removed = (current?.removed ?? []).filter((r) => r.keyHash !== member.keyHash);
  if (member.replaces && current?.members.some((m) => m.keyHash === member.replaces)) {
    removed.push({ keyHash: member.replaces, removedAt: now });
  }
  return {
    type: "relay-directory",
    version: (current?.version ?? 0) + 1,
    issuedAt: now,
    signer,
    members: [...members, member],
    removed,
    admins,
    blobSize: current?.blobSize,
    decoys: current?.decoys,
  };
}

export function directoryWithoutMember(current: Directory, signer: string, keyHash: string, now = Date.now()): Directory {
  return directoryWithoutMembers(current, signer, [keyHash], now);
}

export function directoryWithoutMembers(current: Directory, signer: string, keyHashes: string[], now = Date.now()): Directory {
  const gone = new Set(keyHashes);
  const goneSigs = new Set(current.members.filter((m) => gone.has(m.keyHash)).map((m) => m.sig));
  const admins = (current.admins ?? [signer]).filter((a) => !goneSigs.has(a));
  if (admins.length === 0) throw new Error("Can't remove the last admin. Make someone else an admin first.");
  return {
    type: "relay-directory",
    version: current.version + 1,
    issuedAt: now,
    signer,
    members: current.members.filter((m) => !gone.has(m.keyHash)),
    removed: [
      ...current.removed.filter((r) => !gone.has(r.keyHash)),
      ...keyHashes.map((keyHash) => ({ keyHash, removedAt: now })),
    ],
    admins,
    blobSize: current.blobSize,
    decoys: current.decoys,
  };
}

/** Next directory version with a different admin list. Admins must be members; at least one must remain. */
export function directoryWithAdmins(current: Directory, signer: string, admins: string[], now = Date.now()): Directory {
  const sigs = new Set(current.members.map((m) => m.sig));
  const next = [...new Set(admins)].filter((a) => sigs.has(a));
  if (next.length === 0) throw new Error("At least one admin must remain");
  return { ...current, version: current.version + 1, issuedAt: now, signer, admins: next };
}

/** Short, comparable fingerprint of a public key: first 16 hex chars of its SHA-256, grouped. */
export async function fingerprint(publicKeyBase64: string): Promise<string> {
  const hex = await sha256Hex(publicKeyBase64);
  return hex.slice(0, 16).match(/.{4}/g)!.join(" ");
}

/** Next directory version with new blob settings (admin setting, protocol v2). */
export function directoryWithBlobSettings(current: Directory, signer: string, blobSize: number, decoys: number, now = Date.now()): Directory {
  if (blobSettings({ ...current, blobSize, decoys }).blobSize !== blobSize) throw new Error("Blob size must be 16-256 KB in 1 KB steps");
  if (blobSettings({ ...current, blobSize, decoys }).decoys !== decoys) throw new Error(`Decoys must be 0-${MAX_DECOYS}`);
  return { ...current, version: current.version + 1, issuedAt: now, signer, blobSize, decoys };
}
