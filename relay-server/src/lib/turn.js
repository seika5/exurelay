import { createHmac } from "crypto";

const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

/**
 * Short-lived TURN credentials for coturn's `use-auth-secret` (TURN REST API scheme).
 * username = "<unix expiry>:relay", credential = base64(HMAC-SHA1(secret, username)).
 * The username deliberately carries no member identity, since coturn may log it.
 */
export function createTurnCredentials(secret, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + ttlSeconds;
  const username = `${expiry}:relay`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential, ttlSeconds };
}

/**
 * ICE servers for clients, from env:
 * TURN_SECRET (shared with coturn's static-auth-secret), TURN_URLS (comma-separated turn:/turns: URLs),
 * STUN_URLS (optional, comma-separated), TURN_TTL_SECONDS (optional).
 * Returns [] when TURN isn't configured, so clients fall back to their default STUN.
 */
export function getIceServersFromEnv(env = process.env, now = Date.now()) {
  const split = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const turnUrls = split(env.TURN_URLS);
  const stunUrls = split(env.STUN_URLS);
  if (!env.TURN_SECRET || turnUrls.length === 0) return { iceServers: [], ttlSeconds: 0 };
  const ttl = Number(env.TURN_TTL_SECONDS) > 0 ? Number(env.TURN_TTL_SECONDS) : DEFAULT_TTL_SECONDS;
  const { username, credential, ttlSeconds } = createTurnCredentials(env.TURN_SECRET, ttl, now);
  const iceServers = [];
  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });
  iceServers.push({ urls: turnUrls, username, credential });
  return { iceServers, ttlSeconds };
}
