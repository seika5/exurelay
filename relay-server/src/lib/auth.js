import { randomBytes } from "crypto";
import { parseBody, verifySigned } from "./signed.js";

/**
 * Challenge-response login. The server hands out a random nonce, the member signs
 * { type: "relay-login", keyHash, nonce, server } with their ECDSA key, and gets a short-lived session.
 * Sessions are the only identified credential: they pay for token issuance, admin requests and the socket.
 * Everything lives in memory, so nothing about who logged in when is written to disk.
 */

export const CHALLENGE_TTL_MS = 60_000;
export const SESSION_TTL_MS = 15 * 60_000;

const trimSlash = (u) => (typeof u === "string" ? u.replace(/\/+$/, "") : u);

export function createAuth({ now = () => Date.now(), publicUrl = process.env.PUBLIC_URL || "" } = {}) {
  publicUrl = trimSlash(publicUrl);
  const challenges = new Map(); // nonce -> expiresAt
  const sessions = new Map(); // token -> { keyHash, signingPublicKey, expiresAt }

  function sweep() {
    const t = now();
    for (const [k, exp] of challenges) if (exp <= t) challenges.delete(k);
    for (const [k, s] of sessions) if (s.expiresAt <= t) sessions.delete(k);
  }

  function challenge() {
    sweep();
    if (challenges.size > 10_000) throw new Error("too many pending logins");
    const nonce = randomBytes(32).toString("base64");
    challenges.set(nonce, now() + CHALLENGE_TTL_MS);
    return nonce;
  }

  /** member: { keyHash, signingPublicKey } from the Member table, or null. */
  async function login(envelope, member) {
    const body = parseBody(envelope);
    if (!body || body.type !== "relay-login" || typeof body.nonce !== "string") return { ok: false, error: "malformed login" };
    const exp = challenges.get(body.nonce);
    if (!exp || exp <= now()) return { ok: false, error: "unknown or expired challenge" };
    // A nonce is good for one attempt, right or wrong.
    challenges.delete(body.nonce);
    // Stops another relay from passing our challenge to a member and logging in as them with the answer.
    if (publicUrl && trimSlash(body.server) !== publicUrl) return { ok: false, error: "login is for a different server" };
    if (!member || member.keyHash !== body.keyHash) return { ok: false, error: "not a member" };
    if (!(await verifySigned(envelope, member.signingPublicKey))) return { ok: false, error: "bad signature" };
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now() + SESSION_TTL_MS;
    sessions.set(token, { keyHash: member.keyHash, signingPublicKey: member.signingPublicKey, expiresAt });
    return { ok: true, session: token, expiresAt };
  }

  function getSession(token) {
    if (typeof token !== "string") return null;
    const s = sessions.get(token);
    if (!s || s.expiresAt <= now()) return null;
    return s;
  }

  /** Drop every session of a removed member so they can't keep refilling tokens. */
  function revokeKeyHashes(keyHashes) {
    const gone = new Set(keyHashes);
    for (const [k, s] of sessions) if (gone.has(s.keyHash)) sessions.delete(k);
  }

  return { challenge, login, getSession, revokeKeyHashes };
}

export function bearer(req) {
  const h = req.headers.authorization;
  return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : null;
}
