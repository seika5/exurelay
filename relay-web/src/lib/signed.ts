/**
 * Signed records: { body, signature }, where body is the exact JSON string that was signed, so verifiers
 * never re-serialize. ECDSA P-256 / SHA-256, raw (r||s) signatures, base64. Must match relay-server/src/lib/signed.js.
 *
 * Three record types:
 * - Enrollment code (newcomer → admin, in person): the newcomer's keys + chosen name, valid 3 minutes.
 * - Directory (admin-signed): every member's keys, plus removed members. Version only goes up.
 * - Profile (member-signed): a member's display name.
 */

import { exportPublicKey, importSigningPublicKey, sha256Hex } from "./crypto";

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
};

export type Profile = { type: "relay-profile"; keyHash: string; name: string; updatedAt: number };

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
 * Verify a directory against the admin keys built into this app. minVersion is the newest version this
 * device has already accepted: anything older is refused, so a server can't replay a pre-removal list.
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

/** Next directory version with a newcomer added. With replaces, the old key is moved to removed. */
export function directoryWithMember(
  current: Directory | null,
  signer: string,
  member: DirectoryMember,
  now = Date.now()
): Directory {
  const members = (current?.members ?? []).filter((m) => m.keyHash !== member.keyHash && m.keyHash !== member.replaces);
  const removed = (current?.removed ?? []).filter((r) => r.keyHash !== member.keyHash);
  if (member.replaces && current?.members.some((m) => m.keyHash === member.replaces)) {
    removed.push({ keyHash: member.replaces, removedAt: now });
  }
  return { type: "relay-directory", version: (current?.version ?? 0) + 1, issuedAt: now, signer, members: [...members, member], removed };
}

export function directoryWithoutMember(current: Directory, signer: string, keyHash: string, now = Date.now()): Directory {
  return {
    type: "relay-directory",
    version: current.version + 1,
    issuedAt: now,
    signer,
    members: current.members.filter((m) => m.keyHash !== keyHash),
    removed: [...current.removed.filter((r) => r.keyHash !== keyHash), { keyHash, removedAt: now }],
  };
}

/** Short, comparable fingerprint of a public key: first 16 hex chars of its SHA-256, grouped. */
export async function fingerprint(publicKeyBase64: string): Promise<string> {
  const hex = await sha256Hex(publicKeyBase64);
  return hex.slice(0, 16).match(/.{4}/g)!.join(" ");
}

/** Admin signing keys built into this app (NEXT_PUBLIC_ADMIN_SIGNING_KEYS). */
export function builtInAdminKeys(): string[] {
  return (process.env.NEXT_PUBLIC_ADMIN_SIGNING_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
}
