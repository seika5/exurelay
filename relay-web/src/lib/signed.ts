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
  /** Admin setting: members may turn on notifications for every message and call start (off unless true). */
  notifyAll?: boolean;
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

/**
 * A member's linked device (DESIGN.md §4): its own keys, certified by one of the member's devices (their enrolled
 * key or an already-certified device). `signer` is the certifying device's signing key.
 */
/** Public, so no device name: names travel sealed to the member's own devices (profileSeal.ts). */
export type DeviceCert = { type: "relay-device"; member: string; ecdh: string; sig: string; addedAt: number; signer: string };
export type DeviceRevoke = { type: "relay-device-revoke"; member: string; keyHash: string; revokedAt: number; signer: string };
/** A verified device of a member, including their enrolled one (primary). */
export type MemberDevice = { keyHash: string; ecdh: string; sig: string; name: string; addedAt: number; primary: boolean };

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

/**
 * The member and name in an enrollment code passed along as an introduction (profileSeal.ts `intros`): the code's keys
 * must be a current member's, and it must be signed by their signing key. No expiry: it only vouches for a name.
 */
export async function readIntroduction(code: string, members: DirectoryMember[]): Promise<{ keyHash: string; name: string } | null> {
  const trimmed = code.trim();
  if (trimmed.slice(0, ENROLL_PREFIX.length).toUpperCase() !== ENROLL_PREFIX) return null;
  try {
    const env = JSON.parse(atob(trimmed.slice(ENROLL_PREFIX.length))) as SignedEnvelope;
    const req = parse<EnrollmentRequest>(env);
    if (!req || req.type !== "relay-enroll" || typeof req.name !== "string") return null;
    const member = members.find((m) => m.ecdh === req.ecdh && m.sig === req.sig);
    if (!member || !(await verifyRecord(env, member.sig))) return null;
    const name = req.name.trim().slice(0, MAX_NAME_LENGTH);
    return name ? { keyHash: member.keyHash, name } : null;
  } catch {
    return null;
  }
}

/**
 * A member's name signed by one of their devices (profileSeal.ts `signed` / `relay`): { type: "relay-profile", keyHash,
 * name, updatedAt }. Null unless it's well formed and signed by a current device of that member.
 */
export async function readSignedName(
  json: string,
  devicesOf: (member: string) => { sig: string }[] | undefined
): Promise<{ keyHash: string; name: string; updatedAt: number } | null> {
  try {
    const env = JSON.parse(json) as SignedEnvelope;
    if (typeof env?.body !== "string" || typeof env?.signature !== "string") return null;
    const p = parse<Profile>(env);
    if (!p || p.type !== "relay-profile" || typeof p.keyHash !== "string" || typeof p.name !== "string" || !Number.isSafeInteger(p.updatedAt)) return null;
    const signers = devicesOf(p.keyHash);
    if (!signers?.length) return null;
    let ok = false;
    for (const d of signers) if (!ok && (await verifyRecord(env, d.sig))) ok = true;
    const name = p.name.trim().slice(0, MAX_NAME_LENGTH);
    return ok && name ? { keyHash: p.keyHash, name, updatedAt: p.updatedAt } : null;
  } catch {
    return null;
  }
}

/** Decode and check an enrollment code: signed by the key it carries, and less than 3 minutes old. */
export async function readEnrollmentCode(
  code: string,
  now = Date.now()
): Promise<{ ok: true; request: EnrollmentRequest; keyHash: string } | { ok: false; error: string }> {
  const trimmed = code.trim();
  // The prefix in any case: some chat apps change its capitalization when it's pasted. The payload after it is exact.
  if (trimmed.slice(0, ENROLL_PREFIX.length).toUpperCase() !== ENROLL_PREFIX) {
    const isJoin = trimmed.slice(0, 11).toUpperCase() === "RELAY-JOIN:" || trimmed.includes("#join=");
    return {
      ok: false,
      error: isJoin
        ? "That's the server's join code. Use the code on the new device's waiting screen (it starts with RELAY-ENROLL:)."
        : "Not an Exurelay device code. Use the code on the new device's waiting screen (it starts with RELAY-ENROLL:).",
    };
  }
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

/**
 * Each member's devices, by member keyHash: their enrolled key first, then every certificate signed (directly or
 * through another certified device) by one of their devices, minus those unlinked by one of their devices. The
 * server checks the same, but clients don't trust it to.
 */
export async function verifyDevices(
  certs: SignedEnvelope[],
  revocations: SignedEnvelope[],
  members: DirectoryMember[],
  /** Filled with the key hashes of devices validly unlinked (so an unlinked device can tell). */
  revoked: Set<string> = new Set()
): Promise<Map<string, MemberDevice[]>> {
  const out = new Map<string, MemberDevice[]>();
  const pending: { env: SignedEnvelope; d: DeviceCert }[] = [];
  for (const env of certs) {
    const d = parse<DeviceCert>(env);
    if (d?.type === "relay-device" && typeof d.member === "string" && typeof d.ecdh === "string" && typeof d.sig === "string") pending.push({ env, d });
  }
  const taken = new Set(members.map((m) => m.keyHash));
  for (const m of members) out.set(m.keyHash, [{ keyHash: m.keyHash, ecdh: m.ecdh, sig: m.sig, name: "", addedAt: m.enrolledAt, primary: true }]);
  // Accept certificates whose signer is already one of the member's devices, until nothing new is accepted.
  for (let progress = true; progress; ) {
    progress = false;
    for (const p of [...pending]) {
      const list = out.get(p.d.member);
      if (!list || !list.some((x) => x.sig === p.d.signer)) continue;
      pending.splice(pending.indexOf(p), 1);
      const keyHash = await keyHashOf(p.d.ecdh);
      if (taken.has(keyHash) || !(await verifyRecord(p.env, p.d.signer))) continue;
      taken.add(keyHash);
      // Older certificates carried a name in plain text; it's ignored (the name comes sealed, profileSeal.ts).
      list.push({ keyHash, ecdh: p.d.ecdh, sig: p.d.sig, name: "", addedAt: p.d.addedAt, primary: false });
      progress = true;
    }
  }
  for (const env of revocations) {
    const r = parse<DeviceRevoke>(env);
    const list = r?.type === "relay-device-revoke" ? out.get(r.member) : undefined;
    if (!r || !list || !list.some((x) => x.sig === r.signer)) continue;
    const target = list.find((x) => x.keyHash === r.keyHash && !x.primary);
    if (target && (await verifyRecord(env, r.signer))) {
      list.splice(list.indexOf(target), 1);
      revoked.add(r.keyHash);
    }
  }
  return out;
}

/** A device certificate for a new device of `member`, from its enrollment code, to be signed by `signer`. */
export function deviceCert(member: string, request: EnrollmentRequest, signer: string, now = Date.now()): DeviceCert {
  return { type: "relay-device", member, ecdh: request.ecdh, sig: request.sig, addedAt: now, signer };
}

export function deviceRevoke(member: string, keyHash: string, signer: string, now = Date.now()): DeviceRevoke {
  return { type: "relay-device-revoke", member, keyHash, revokedAt: now, signer };
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
    notifyAll: current?.notifyAll,
  };
}

/** A member's signing keys: their enrolled key and every linked device's (any of them can be the admin device). */
export function memberSigs(m: { keyHash: string; sig: string }, devices: Map<string, MemberDevice[]> = new Map()): string[] {
  return [m.sig, ...(devices.get(m.keyHash) ?? []).filter((d) => !d.primary).map((d) => d.sig)];
}

export function directoryWithoutMember(
  current: Directory,
  signer: string,
  keyHash: string,
  now = Date.now(),
  devices: Map<string, MemberDevice[]> = new Map()
): Directory {
  return directoryWithoutMembers(current, signer, [keyHash], now, devices);
}

/** Next version without these members; admin rights held by any of their devices go with them. */
export function directoryWithoutMembers(
  current: Directory,
  signer: string,
  keyHashes: string[],
  now = Date.now(),
  devices: Map<string, MemberDevice[]> = new Map()
): Directory {
  const gone = new Set(keyHashes);
  const goneSigs = new Set(current.members.filter((m) => gone.has(m.keyHash)).flatMap((m) => memberSigs(m, devices)));
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
    notifyAll: current.notifyAll,
  };
}

/**
 * Next directory version with a different admin list. Admins must be members' keys or their linked devices' keys;
 * at least one must remain.
 */
export function directoryWithAdmins(
  current: Directory,
  signer: string,
  admins: string[],
  now = Date.now(),
  devices: Map<string, MemberDevice[]> = new Map()
): Directory {
  const sigs = new Set(current.members.flatMap((m) => memberSigs(m, devices)));
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
/** Whether this server's admins let members get notified for every message and call start. */
export function notifyAllAllowed(d: Directory | null): boolean {
  return d?.notifyAll === true;
}

/** Next directory version with the every-message notifications setting changed. */
export function directoryWithNotifyAll(current: Directory, signer: string, on: boolean, now = Date.now()): Directory {
  return { ...current, version: current.version + 1, issuedAt: now, signer, notifyAll: on };
}

export function directoryWithBlobSettings(current: Directory, signer: string, blobSize: number, decoys: number, now = Date.now()): Directory {
  if (blobSettings({ ...current, blobSize, decoys }).blobSize !== blobSize) throw new Error("Blob size must be 16-256 KB in 1 KB steps");
  if (blobSettings({ ...current, blobSize, decoys }).decoys !== decoys) throw new Error(`Decoys must be 0-${MAX_DECOYS}`);
  return { ...current, version: current.version + 1, issuedAt: now, signer, blobSize, decoys };
}
