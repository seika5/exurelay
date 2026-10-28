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
