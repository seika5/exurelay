import { keyHashOf, parseBody, verifySigned } from "./signed.js";
import { MAX_NAME_LENGTH } from "./directory.js";

/**
 * Linked devices (DESIGN.md §4 "Decided: linked devices"). A member is their enrolled key (in the admin-signed
 * directory); each other device has its own keys and a certificate signed by one of the member's devices: the
 * enrolled key or an already-certified device. Any of them can also unlink a device. The server checks the
 * signatures so it only stores valid records; clients check them all again against the directory.
 */

const isB64 = (s) => typeof s === "string" && s.length > 0 && s.length < 200 && /^[A-Za-z0-9+/]+=*$/.test(s);
const isTime = (n) => Number.isSafeInteger(n) && n > 0;

/** Signing keys that may act for this member: their enrolled key, then each certified device's. */
export async function memberSigners(prisma, memberKeyHash) {
  const member = await prisma.member.findUnique({ where: { keyHash: memberKeyHash } });
  if (!member) return { member: null, signers: [], devices: [] };
  const devices = await prisma.device.findMany({ where: { member: memberKeyHash } });
  return { member, signers: [member.signingPublicKey, ...devices.map((d) => d.signingPublicKey)], devices };
}

async function signedByOneOf(envelope, signer, signers) {
  return typeof signer === "string" && signers.includes(signer) && (await verifySigned(envelope, signer));
}

/**
 * Check { type: "relay-device", member, ecdh, sig, name, addedAt, signer }. `taken(keyHash, sig)` says whether
 * those keys already belong to a member or device, or were unlinked.
 */
export async function validateDeviceCert(envelope, signers, taken) {
  const d = parseBody(envelope);
  if (!d || d.type !== "relay-device" || typeof d.member !== "string") return { ok: false, error: "not a device certificate" };
  if (!isB64(d.ecdh) || !isB64(d.sig) || !isTime(d.addedAt)) return { ok: false, error: "malformed device" };
  if (typeof d.name !== "string" || !d.name.trim() || d.name.length > MAX_NAME_LENGTH) return { ok: false, error: "bad device name" };
  if (!(await signedByOneOf(envelope, d.signer, signers))) return { ok: false, error: "not signed by one of the member's devices" };
  const keyHash = keyHashOf(d.ecdh);
  if (await taken(keyHash, d.sig)) return { ok: false, error: "those keys are already in use or were unlinked" };
  return { ok: true, device: { ...d, keyHash } };
}

/** Check { type: "relay-device-revoke", member, keyHash, revokedAt, signer } for one of this member's devices. */
export async function validateDeviceRevoke(envelope, signers, devices) {
  const r = parseBody(envelope);
  if (!r || r.type !== "relay-device-revoke" || typeof r.member !== "string" || typeof r.keyHash !== "string" || !isTime(r.revokedAt)) {
    return { ok: false, error: "not a device unlink" };
  }
  if (!devices.some((d) => d.keyHash === r.keyHash)) return { ok: false, error: "not one of this member's linked devices" };
  if (!(await signedByOneOf(envelope, r.signer, signers))) return { ok: false, error: "not signed by one of the member's devices" };
  return { ok: true, revoke: r };
}
