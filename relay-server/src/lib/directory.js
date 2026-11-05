import { createHash, timingSafeEqual } from "node:crypto";
import { keyHashOf, parseBody, verifySigned } from "./signed.js";

export const MAX_NAME_LENGTH = 64;
/** Blob size and decoy count are admin settings in the signed directory (DESIGN.md §5, protocol v2). */
export const DEFAULT_BLOB_SIZE = 65536;
export const MIN_BLOB_SIZE = 16384;
export const MAX_BLOB_SIZE = 262144;
export const DEFAULT_DECOYS = 3;
export const MAX_DECOYS = 16;
const MAX_MEMBERS = 1000;

const isB64 = (s) => typeof s === "string" && s.length > 0 && s.length < 200 && /^[A-Za-z0-9+/]+=*$/.test(s);
const isTime = (n) => Number.isSafeInteger(n) && n > 0;

/** Admin signing keys from ADMIN_SIGNING_KEYS (comma-separated base64 raw ECDSA P-256 public keys). */
export function adminKeysFromEnv(env = process.env) {
  return (env.ADMIN_SIGNING_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Admins trusted to sign the next directory: the `admins` list in the newest directory once there is one,
 * otherwise ADMIN_SIGNING_KEYS (which only bootstraps the first directory).
 */
export function trustedAdmins(latestBody, envKeys = adminKeysFromEnv()) {
  if (latestBody) {
    try {
      const d = JSON.parse(latestBody);
      if (Array.isArray(d.admins) && d.admins.length > 0) return d.admins;
    } catch {
      // fall through
    }
  }
  return envKeys;
}

/**
 * The one-time setup code (SETUP_CODE, made by deploy/install.sh) instead of ADMIN_SIGNING_KEYS: before any directory
 * exists, a directory sent with the right code may be signed by any key, and that key becomes the first admin.
 * Once there's a directory the code does nothing. Compared by hash, in constant time.
 */
export function setupCodeMatches(expected, offered) {
  if (typeof expected !== "string" || !expected || typeof offered !== "string" || !offered) return false;
  const h = (s) => createHash("sha256").update(s.trim()).digest();
  return timingSafeEqual(h(expected), h(offered));
}

/** The blob size every blob must have, from the newest directory (default before one sets it). */
export function blobSizeOf(latestBody) {
  try {
    const n = JSON.parse(latestBody ?? "null")?.blobSize;
    return Number.isSafeInteger(n) ? n : DEFAULT_BLOB_SIZE;
  } catch {
    return DEFAULT_BLOB_SIZE;
  }
}

/**
 * Check a signed member directory. Returns { ok, directory } or { ok: false, error }.
 * The directory must be signed by one of adminKeys, and its version must be above currentVersion. Admins may be
 * members' enrolled keys or their linked devices' keys (deviceSigsOf(memberKeyHash) lists those).
 */
export async function validateDirectory(envelope, adminKeys, currentVersion = 0, deviceSigsOf = () => []) {
  const d = parseBody(envelope);
  if (!d || d.type !== "relay-directory") return { ok: false, error: "not a directory" };
  if (!adminKeys.includes(d.signer)) return { ok: false, error: "signer is not an admin" };
  if (!(await verifySigned(envelope, d.signer))) return { ok: false, error: "bad signature" };
  if (!Number.isSafeInteger(d.version) || d.version <= currentVersion) {
    return { ok: false, error: `version must be greater than ${currentVersion}` };
  }
  if (!isTime(d.issuedAt) || !Array.isArray(d.members) || !Array.isArray(d.removed)) {
    return { ok: false, error: "malformed directory" };
  }
  if (d.members.length > MAX_MEMBERS) return { ok: false, error: "too many members" };
  const hashes = new Set();
  const sigKeys = new Set();
  for (const m of d.members) {
    if (!m || !isB64(m.ecdh) || !isB64(m.sig) || !isTime(m.enrolledAt)) return { ok: false, error: "malformed member" };
    if (m.keyHash !== keyHashOf(m.ecdh)) return { ok: false, error: "member keyHash does not match key" };
    if (m.replaces != null && typeof m.replaces !== "string") return { ok: false, error: "malformed replaces" };
    if (hashes.has(m.keyHash) || sigKeys.has(m.sig)) return { ok: false, error: "duplicate member" };
    hashes.add(m.keyHash);
    sigKeys.add(m.sig);
  }
  if (d.admins != null) {
    if (!Array.isArray(d.admins) || d.admins.length === 0 || d.admins.length > 20) return { ok: false, error: "malformed admins" };
    // An admin is a member's enrolled key or one of their linked devices (the member's "admin device").
    const deviceSigs = new Set(d.members.flatMap((m) => deviceSigsOf(m.keyHash)));
    if (!d.admins.every((a) => isB64(a) && (sigKeys.has(a) || deviceSigs.has(a)))) {
      return { ok: false, error: "every admin must be a member or one of their devices" };
    }
  }
  if (d.blobSize != null && !(Number.isSafeInteger(d.blobSize) && d.blobSize % 1024 === 0 && d.blobSize >= MIN_BLOB_SIZE && d.blobSize <= MAX_BLOB_SIZE)) {
    return { ok: false, error: `blobSize must be a multiple of 1024 from ${MIN_BLOB_SIZE} to ${MAX_BLOB_SIZE}` };
  }
  if (d.decoys != null && !(Number.isSafeInteger(d.decoys) && d.decoys >= 0 && d.decoys <= MAX_DECOYS)) {
    return { ok: false, error: `decoys must be 0-${MAX_DECOYS}` };
  }
  for (const r of d.removed) {
    if (!r || typeof r.keyHash !== "string" || !isTime(r.removedAt)) return { ok: false, error: "malformed removal" };
    if (hashes.has(r.keyHash)) return { ok: false, error: "member is both enrolled and removed" };
  }
  return { ok: true, directory: d };
}

/** Signed by any of these keys (a member's enrolled key or one of their linked devices). */
async function verifiedByAny(envelope, signers) {
  for (const k of signers) if (await verifySigned(envelope, k)) return true;
  return false;
}

export const LEAVE_MAX_AGE_MS = 5 * 60_000;

const trimSlash = (u) => (typeof u === "string" ? u.replace(/\/+$/, "") : u);

/**
 * Check a member's signed { type: "relay-leave", keyHash, server, ts }. Returns { ok, leave } or { ok: false, error }.
 * server must match publicUrl when it's set, so a leave signed for another relay can't be replayed here.
 * The last admin can't leave: nobody would be left to sign the next directory.
 */
export async function validateLeave(
  envelope,
  member,
  adminKeys,
  { publicUrl = "", now = Date.now(), signers = member ? [member.signingPublicKey] : [] } = {}
) {
  const l = parseBody(envelope);
  if (!l || l.type !== "relay-leave" || typeof l.keyHash !== "string") return { ok: false, error: "not a leave request" };
  if (!member || member.keyHash !== l.keyHash) return { ok: false, error: "not a member" };
  if (!(await verifiedByAny(envelope, signers))) return { ok: false, error: "bad signature" };
  if (publicUrl && trimSlash(l.server) !== trimSlash(publicUrl)) return { ok: false, error: "leave is for a different server" };
  if (!isTime(l.ts) || Math.abs(now - l.ts) > LEAVE_MAX_AGE_MS) return { ok: false, error: "stale leave request" };
  if (adminKeys.length === 1 && adminKeys[0] === member.signingPublicKey) {
    return { ok: false, error: "You're the only admin. Make someone else an admin before leaving." };
  }
  return { ok: true, leave: l };
}
