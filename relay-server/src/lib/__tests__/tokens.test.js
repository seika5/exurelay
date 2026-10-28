/**
 * Unit tests for anonymous tokens (RFC 9474 issuer) and challenge-response login.
 * Run: node --test src/lib/__tests__/tokens.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { constants, createPrivateKey, randomBytes, sign as rsaSign, webcrypto } from "crypto";
import { BURST, createIssuer, DAY_MS, MAX_BATCH, parseTokenHeader, utcMidnight } from "../tokens.js";
import { createAuth } from "../auth.js";

/** Just enough of Prisma for the issuer: issuerKey and spentToken in memory. */
function fakePrisma() {
  const keys = [];
  const spent = new Map();
  const live = (where, k) => !where?.notAfter?.gt || k.notAfter > where.notAfter.gt;
  return {
    keys,
    issuerKey: {
      findMany: async ({ where }) => keys.filter((k) => live(where, k)).sort((a, b) => a.notBefore - b.notBefore),
      findFirst: async ({ where }) =>
        keys.find((k) => k.reason === where.reason && k.notBefore.getTime() === where.notBefore.getTime()) ?? null,
      create: async ({ data }) => {
        if (keys.some((k) => k.reason === data.reason && k.notBefore.getTime() === data.notBefore.getTime())) {
          throw Object.assign(new Error("dup"), { code: "P2002" });
        }
        keys.push({ ...data });
      },
      updateMany: async ({ where, data }) => {
        for (const k of keys) if (live(where, k)) Object.assign(k, data);
      },
    },
    spentToken: {
      create: async ({ data }) => {
        if (spent.has(data.hash)) throw Object.assign(new Error("dup"), { code: "P2002" });
        spent.set(data.hash, data);
      },
    },
  };
}

/** A token as the client ends up with it: a PSS signature over the prepared message (what unblinding yields). */
function mintToken(key) {
  const prepared = randomBytes(64);
  const priv = createPrivateKey({ key: key.privateKey, format: "der", type: "pkcs8" });
  const sig = rsaSign("sha384", prepared, { key: priv, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 });
  return `${key.id}.${prepared.toString("base64url")}.${sig.toString("base64url")}`;
}

describe("token issuer", () => {
  const T0 = Date.UTC(2026, 9, 28, 15, 0, 0);

  it("creates one daily key per UTC day, valid for 48 hours", async () => {
    const prisma = fakePrisma();
    let t = T0;
    const issuer = createIssuer(prisma, { now: () => t });
    await issuer.ensureDailyKey();
    await issuer.ensureDailyKey();
    assert.strictEqual(prisma.keys.length, 1);
    const [k] = await issuer.publicKeys();
    assert.strictEqual(k.notBefore, utcMidnight(T0));
    assert.strictEqual(k.notAfter, utcMidnight(T0) + 2 * DAY_MS);
    t = T0 + DAY_MS;
    await issuer.ensureDailyKey();
    assert.strictEqual(prisma.keys.length, 2);
  });

  it("spends a valid token once", async () => {
    const prisma = fakePrisma();
    const issuer = createIssuer(prisma, { now: () => T0 });
    const key = await issuer.issuingKey();
    const token = mintToken(key);
    assert.strictEqual(await issuer.spend(token), true);
    assert.strictEqual(await issuer.spend(token), false, "double spend");
    assert.strictEqual(await issuer.spend("garbage"), false);
  });

  it("refuses a token signed by a different key", async () => {
    const issuer = createIssuer(fakePrisma(), { now: () => T0 });
    const key = await issuer.issuingKey();
    const other = createIssuer(fakePrisma(), { now: () => T0 + 1 });
    const otherKey = await other.issuingKey();
    const forged = mintToken({ ...otherKey, id: key.id });
    assert.strictEqual(await issuer.spend(forged), false);
  });

  it("removal ends every key at once and starts a new one", async () => {
    const prisma = fakePrisma();
    let t = T0;
    const issuer = createIssuer(prisma, { now: () => t });
    const before = await issuer.issuingKey();
    const oldToken = mintToken(before);
    t = T0 + 1000;
    await issuer.rotateForRemoval(7);
    t = T0 + 20_000; // past the issuer's 10 s key cache
    assert.strictEqual(await issuer.spend(oldToken), false);
    const after = await issuer.issuingKey();
    assert.notStrictEqual(after.id, before.id);
    assert.strictEqual(after.reason, "removal");
    assert.strictEqual(after.directoryVersion, 7);
    // Today's daily key isn't recreated after the removal.
    await issuer.ensureDailyKey();
    assert.strictEqual((await issuer.issuingKey()).id, after.id);
  });

  it("blind-signs, rate-limits per member and refuses a stale key id", async () => {
    let t = T0;
    const issuer = createIssuer(fakePrisma(), { now: () => t, ratePerMinute: 60 });
    const key = await issuer.issuingKey();
    // Any value below the modulus works as a "blinded message" for the raw signature.
    const blinded = Buffer.alloc(256, 0);
    blinded[255] = 5;
    const b = (n) => Array(n).fill(blinded.toString("base64"));
    const ok = await issuer.issue("alice", key.id, b(2));
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.signatures.length, 2);
    assert.strictEqual(ok.remaining, BURST - 2);
    assert.strictEqual((await issuer.issue("alice", key.id, b(MAX_BATCH))).ok, true);
    const over = await issuer.issue("alice", key.id, b(MAX_BATCH));
    assert.strictEqual(over.status, 429);
    assert.strictEqual(over.remaining, BURST - 2 - MAX_BATCH);
    assert.strictEqual(over.retryAfter, 1);
    // Emptied, the wait is for one token: a second at 60 per minute.
    assert.strictEqual((await issuer.issue("alice", key.id, b(over.remaining))).ok, true);
    assert.strictEqual((await issuer.issue("alice", key.id, b(1))).retryAfter, 1);
    // Another member has their own bucket; one per second refills alice's.
    assert.strictEqual((await issuer.issue("bob", key.id, b(MAX_BATCH))).ok, true);
    t += MAX_BATCH * 1000;
    assert.strictEqual((await issuer.issue("alice", key.id, b(MAX_BATCH))).ok, true);
    assert.strictEqual((await issuer.issue("bob", "0".repeat(32), b(1))).status, 409);
    assert.strictEqual((await issuer.issue("bob", key.id, [Buffer.alloc(256, 0xff).toString("base64")])).status, 400);
    assert.deepStrictEqual(issuer.stats(), { ratePerMinute: 60, burst: BURST, issuedToday: 2 + 3 * MAX_BATCH + (BURST - 2 - MAX_BATCH) });
  });

  it("parses only well-formed token headers", () => {
    assert.strictEqual(parseTokenHeader("a.b.c"), null);
    assert.strictEqual(parseTokenHeader(undefined), null);
  });
});

describe("login", () => {
  const subtle = webcrypto.subtle;
  async function memberWithKey() {
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pub = Buffer.from(await subtle.exportKey("raw", pair.publicKey)).toString("base64");
    return { pair, member: { keyHash: "aa", signingPublicKey: pub } };
  }
  async function signLogin(pair, body) {
    const text = JSON.stringify(body);
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(text));
    return { body: text, signature: Buffer.from(sig).toString("base64") };
  }

  it("issues a session for a signed, fresh challenge, once", async () => {
    const auth = createAuth({ publicUrl: "https://relay.test" });
    const { pair, member } = await memberWithKey();
    const nonce = auth.challenge();
    const env = await signLogin(pair, { type: "relay-login", keyHash: "aa", nonce, server: "https://relay.test" });
    const r = await auth.login(env, member);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(auth.getSession(r.session).keyHash, "aa");
    assert.strictEqual((await auth.login(env, member)).ok, false, "nonce reuse");
    auth.revokeKeyHashes(["aa"]);
    assert.strictEqual(auth.getSession(r.session), null);
  });

  it("refuses a login signed for another server or by another key", async () => {
    const auth = createAuth({ publicUrl: "https://relay.test" });
    const { pair, member } = await memberWithKey();
    const other = await memberWithKey();
    const n1 = auth.challenge();
    const wrongServer = await signLogin(pair, { type: "relay-login", keyHash: "aa", nonce: n1, server: "https://evil.test" });
    assert.strictEqual((await auth.login(wrongServer, member)).ok, false);
    const n2 = auth.challenge();
    const wrongKey = await signLogin(other.pair, { type: "relay-login", keyHash: "aa", nonce: n2, server: "https://relay.test" });
    assert.strictEqual((await auth.login(wrongKey, member)).ok, false);
  });

  it("expires challenges after a minute", async () => {
    let t = 0;
    const auth = createAuth({ now: () => t, publicUrl: "" });
    const { pair, member } = await memberWithKey();
    const nonce = auth.challenge();
    t = 61_000;
    const env = await signLogin(pair, { type: "relay-login", keyHash: "aa", nonce, server: "x" });
    assert.strictEqual((await auth.login(env, member)).ok, false);
  });
});
