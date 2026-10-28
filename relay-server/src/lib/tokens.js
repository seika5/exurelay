import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  verify as rsaVerify,
} from "crypto";

/**
 * Anonymous membership tokens: RFC 9474 RSA blind signatures, suite RSABSSA-SHA384-PSS-Randomized.
 *
 * - A logged-in member sends blinded messages; we sign them raw (RSASP1), rate-limited per member (a token bucket:
 *   a burst big enough for a full refill, then a steady rate per minute). There's no daily cap.
 * - The client unblinds them into (msg, sig) pairs we have never seen, then spends one per request.
 * - Spending checks an RSA-PSS (SHA-384, 48-byte salt) signature over the prepared 64-byte message and
 *   records its hash so it can't be spent twice. Nothing ties a spent token back to the issuance.
 *
 * Issuer keys rotate daily (valid 48 h from UTC midnight, so yesterday's tokens last another day) and
 * immediately on a member removal (all older keys end at once, with no overlap). Clients refuse keys that
 * don't follow this schedule; must match relay-web/src/lib/tokens.ts.
 *
 * The client side uses @cloudflare/blindrsa-ts; signing here uses Node's native RSA, which is ~300x faster.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MODULUS_BYTES = 256; // RSA-2048
export const PREPARED_BYTES = 64; // 32-byte random prefix + 32-byte token
export const MAX_BATCH = 100;
export const DEFAULT_RATE_PER_MINUTE = 30;
/** Default burst: two full refills back to back. */
export const BURST = 2 * MAX_BATCH;
const RECENT_MS = 7 * DAY_MS;

export const utcMidnight = (t) => Math.floor(t / DAY_MS) * DAY_MS;

export function keyIdOf(spki) {
  return createHash("sha256").update(spki).digest("hex").slice(0, 32);
}

function newRsaKey() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  return { id: keyIdOf(spki), spki, pkcs8 };
}

/** RSASP1 on a blinded message, checked with RSAVP1 as RFC 9474 §4.3 requires. */
export function blindSign(privateKeyDer, publicKeyDer, blinded) {
  if (!Buffer.isBuffer(blinded) || blinded.length !== MODULUS_BYTES) throw new Error("bad blinded message");
  const priv = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  const pub = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  // privateDecrypt throws if the input isn't below the modulus.
  const sig = privateDecrypt({ key: priv, padding: constants.RSA_NO_PADDING }, blinded);
  const back = publicEncrypt({ key: pub, padding: constants.RSA_NO_PADDING }, sig);
  if (!back.equals(blinded)) throw new Error("signing failure");
  return sig;
}

export function verifyToken(publicKeyDer, prepared, sig) {
  const pub = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  return rsaVerify("sha384", prepared, { key: pub, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, sig);
}

/** Header value: `<keyId>.<base64url prepared message>.<base64url signature>`. */
export function parseTokenHeader(value) {
  if (typeof value !== "string" || value.length > 1000) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [keyId, m, s] = parts;
  if (!/^[0-9a-f]{32}$/.test(keyId)) return null;
  const prepared = Buffer.from(m, "base64url");
  const sig = Buffer.from(s, "base64url");
  if (prepared.length !== PREPARED_BYTES || sig.length !== MODULUS_BYTES) return null;
  return { keyId, prepared, sig };
}

export function createIssuer(
  prisma,
  {
    now = () => Date.now(),
    ratePerMinute = Number(process.env.TOKEN_RATE_PER_MINUTE) || DEFAULT_RATE_PER_MINUTE,
    burst = Number(process.env.TOKEN_BURST) || BURST,
  } = {}
) {
  let cache = null; // { at, keys }
  // keyHash -> { level, at }: tokens available at time `at`. Memory only: per-member activity is never stored.
  const buckets = new Map();
  const perMs = ratePerMinute / 60_000;
  const available = (keyHash) => {
    const b = buckets.get(keyHash);
    return b ? Math.min(burst, b.level + (now() - b.at) * perMs) : burst;
  };
  let issuedTotalDay = 0;
  let issuedTotal = 0;

  async function loadKeys() {
    if (cache && now() - cache.at < 10_000) return cache.keys;
    const keys = await prisma.issuerKey.findMany({ where: { notAfter: { gt: new Date(now()) } }, orderBy: { notBefore: "asc" } });
    cache = { at: now(), keys };
    return keys;
  }

  async function insertKey(reason, notBefore, notAfter, directoryVersion = null) {
    const k = newRsaKey();
    try {
      await prisma.issuerKey.create({
        data: {
          id: k.id,
          publicKey: k.spki,
          privateKey: k.pkcs8,
          reason,
          notBefore: new Date(notBefore),
          notAfter: new Date(notAfter),
          directoryVersion,
        },
      });
    } catch (e) {
      // Another request created today's key first.
      if (e?.code !== "P2002") throw e;
    }
    cache = null;
  }

  /** Make sure today's scheduled key exists. A removal later today doesn't bring it back. */
  async function ensureDailyKey() {
    const midnight = utcMidnight(now());
    const existing = await prisma.issuerKey.findFirst({ where: { reason: "daily", notBefore: new Date(midnight) }, select: { id: true } });
    if (!existing) await insertKey("daily", midnight, midnight + 2 * DAY_MS);
  }

  /** A member was removed: end every key now and start a new one, so their leftover tokens die. */
  async function rotateForRemoval(directoryVersion) {
    const t = now();
    await prisma.issuerKey.updateMany({ where: { notAfter: { gt: new Date(t) } }, data: { notAfter: new Date(t) } });
    await insertKey("removal", t, utcMidnight(t) + 2 * DAY_MS, directoryVersion);
  }

  async function issuingKey() {
    await ensureDailyKey();
    const t = now();
    const keys = (await loadKeys()).filter((k) => k.notBefore.getTime() <= t && k.notAfter.getTime() > t);
    return keys[keys.length - 1] ?? null;
  }

  /**
   * Keys as published at GET /api/tokens/keys: current ones plus those that ended in the last 7 days, so
   * clients can check the issuer named in older messages (no message blob outlives 4 days).
   */
  async function publicKeys() {
    await ensureDailyKey();
    const keys = await prisma.issuerKey.findMany({
      where: { notAfter: { gt: new Date(now() - RECENT_MS) } },
      orderBy: { notBefore: "asc" },
    });
    return keys.map((k) => ({
        id: k.id,
        publicKey: Buffer.from(k.publicKey).toString("base64"),
        reason: k.reason,
        notBefore: k.notBefore.getTime(),
        notAfter: k.notAfter.getTime(),
        directoryVersion: k.directoryVersion ?? undefined,
      }));
  }

  /** Sign a batch of blinded messages for a logged-in member. */
  async function issue(keyHash, keyId, blindedList) {
    if (!Array.isArray(blindedList) || blindedList.length === 0 || blindedList.length > MAX_BATCH) {
      return { ok: false, status: 400, error: `send 1-${MAX_BATCH} blinded messages` };
    }
    const key = await issuingKey();
    if (!key || key.id !== keyId) return { ok: false, status: 409, error: "issuer key changed" };
    // Full buckets carry no information, so drop them.
    for (const k of buckets.keys()) if (available(k) >= burst) buckets.delete(k);
    const level = available(keyHash);
    if (blindedList.length > level) {
      const remaining = Math.floor(level);
      // Seconds until at least one more token is available.
      const retryAfter = Math.max(1, Math.ceil((1 - level) / perMs / 1000));
      return { ok: false, status: 429, error: "token rate limit reached", remaining, retryAfter };
    }
    let signatures;
    try {
      signatures = blindedList.map((b) => blindSign(key.privateKey, key.publicKey, Buffer.from(String(b), "base64")).toString("base64"));
    } catch {
      return { ok: false, status: 400, error: "bad blinded message" };
    }
    buckets.set(keyHash, { level: level - blindedList.length, at: now() });
    const day = utcMidnight(now());
    if (issuedTotalDay !== day) {
      issuedTotalDay = day;
      issuedTotal = 0;
    }
    issuedTotal += blindedList.length;
    return { ok: true, keyId: key.id, signatures, remaining: Math.floor(level - blindedList.length) };
  }

  /** Check and burn one token. Returns true if it was valid and unspent. */
  async function spend(headerValue) {
    const t = parseTokenHeader(headerValue);
    if (!t) return false;
    const key = (await loadKeys()).find((k) => k.id === t.keyId);
    if (!key || key.notBefore.getTime() > now() || key.notAfter.getTime() <= now()) return false;
    if (!verifyToken(key.publicKey, t.prepared, t.sig)) return false;
    const hash = createHash("sha256").update(t.prepared).digest("hex");
    try {
      await prisma.spentToken.create({ data: { hash, expiresAt: key.notAfter } });
    } catch (e) {
      if (e?.code === "P2002") return false;
      throw e;
    }
    return true;
  }

  function stats() {
    return { ratePerMinute, burst, issuedToday: issuedTotalDay === utcMidnight(now()) ? issuedTotal : 0 };
  }

  return { ensureDailyKey, rotateForRemoval, issuingKey, publicKeys, issue, spend, stats };
}

/** Express middleware: the request must carry one unspent token in the Relay-Token header. */
export function requireToken(issuer) {
  return async (req, res, next) => {
    try {
      if (await issuer.spend(req.headers["relay-token"])) return next();
      return res.status(401).json({ error: "invalid or spent token", code: "token" });
    } catch {
      return res.status(500).json({ error: "token check failed" });
    }
  };
}
