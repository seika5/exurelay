import { keyHashOf, parseBody, verifySigned } from "./signed.js";

export const MAX_NAME_LENGTH = 64;
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
 * Check a signed member directory. Returns { ok, directory } or { ok: false, error }.
 * The directory must be signed by one of adminKeys, and its version must be above currentVersion.
 */
export async function validateDirectory(envelope, adminKeys, currentVersion = 0) {
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
    if (!d.admins.every((a) => isB64(a) && sigKeys.has(a))) return { ok: false, error: "every admin must be a member" };
  }
  for (const r of d.removed) {
    if (!r || typeof r.keyHash !== "string" || !isTime(r.removedAt)) return { ok: false, error: "malformed removal" };
    if (hashes.has(r.keyHash)) return { ok: false, error: "member is both enrolled and removed" };
  }
  return { ok: true, directory: d };
}

/**
 * Check a member's self-signed profile against their directory entry.
 * Returns { ok, profile } or { ok: false, error }. updatedAt must be above previousUpdatedAt.
 */
export async function validateProfile(envelope, member, previousUpdatedAt = 0) {
  const p = parseBody(envelope);
  if (!p || p.type !== "relay-profile" || typeof p.keyHash !== "string") return { ok: false, error: "not a profile" };
  if (!member || member.keyHash !== p.keyHash) return { ok: false, error: "not a member" };
  if (!(await verifySigned(envelope, member.signingPublicKey))) return { ok: false, error: "bad signature" };
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: "bad name" };
  }
  if (!isTime(p.updatedAt) || p.updatedAt <= previousUpdatedAt) return { ok: false, error: "stale profile" };
  return { ok: true, profile: p };
}

export const LEAVE_MAX_AGE_MS = 5 * 60_000;

const trimSlash = (u) => (typeof u === "string" ? u.replace(/\/+$/, "") : u);

/**
 * Check a member's signed { type: "relay-leave", keyHash, server, ts }. Returns { ok, leave } or { ok: false, error }.
 * server must match publicUrl when it's set, so a leave signed for another relay can't be replayed here.
 * The last admin can't leave: nobody would be left to sign the next directory.
 */
export async function validateLeave(envelope, member, adminKeys, { publicUrl = "", now = Date.now() } = {}) {
  const l = parseBody(envelope);
  if (!l || l.type !== "relay-leave" || typeof l.keyHash !== "string") return { ok: false, error: "not a leave request" };
  if (!member || member.keyHash !== l.keyHash) return { ok: false, error: "not a member" };
  if (!(await verifySigned(envelope, member.signingPublicKey))) return { ok: false, error: "bad signature" };
  if (publicUrl && trimSlash(l.server) !== trimSlash(publicUrl)) return { ok: false, error: "leave is for a different server" };
  if (!isTime(l.ts) || Math.abs(now - l.ts) > LEAVE_MAX_AGE_MS) return { ok: false, error: "stale leave request" };
  if (adminKeys.length === 1 && adminKeys[0] === member.signingPublicKey) {
    return { ok: false, error: "You're the only admin. Make someone else an admin before leaving." };
  }
  return { ok: true, leave: l };
}
