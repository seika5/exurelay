/**
 * Unit tests for admin-signed directories and member-signed profiles.
 * Run: node --test src/lib/__tests__/directory.test.js
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { webcrypto } from "crypto";
import { validateDirectory, validateProfile } from "../directory.js";
import { keyHashOf } from "../signed.js";

const subtle = webcrypto.subtle;
const b64 = (buf) => Buffer.from(buf).toString("base64");

async function signingKeyPair() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { pair, pub: b64(await subtle.exportKey("raw", pair.publicKey)) };
}

async function ecdhPub() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return b64(await subtle.exportKey("raw", pair.publicKey));
}

async function sign(privateKey, obj) {
  const body = JSON.stringify(obj);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(body));
  return { body, signature: b64(sig) };
}

describe("validateDirectory", () => {
  let admin, member, memberEcdh;
  before(async () => {
    admin = await signingKeyPair();
    member = await signingKeyPair();
    memberEcdh = await ecdhPub();
  });

  const directory = (overrides = {}) => ({
    type: "relay-directory",
    version: 1,
    issuedAt: 1,
    signer: admin.pub,
    members: [{ keyHash: keyHashOf(memberEcdh), ecdh: memberEcdh, sig: member.pub, enrolledAt: 1 }],
    removed: [],
    ...overrides,
  });

  it("accepts a directory signed by an admin", async () => {
    const r = await validateDirectory(await sign(admin.pair.privateKey, directory()), [admin.pub], 0);
    assert.ok(r.ok, r.error);
  });

  it("rejects a signer that isn't an admin", async () => {
    const env = await sign(member.pair.privateKey, directory({ signer: member.pub }));
    assert.strictEqual((await validateDirectory(env, [admin.pub], 0)).ok, false);
  });

  it("rejects a tampered body", async () => {
    const env = await sign(admin.pair.privateKey, directory());
    env.body = env.body.replace('"version":1', '"version":2');
    assert.strictEqual((await validateDirectory(env, [admin.pub], 0)).ok, false);
  });

  it("rejects a version that isn't newer (rollback)", async () => {
    const env = await sign(admin.pair.privateKey, directory({ version: 3 }));
    assert.strictEqual((await validateDirectory(env, [admin.pub], 3)).ok, false);
  });

  it("rejects a keyHash that doesn't match the key", async () => {
    const d = directory();
    d.members[0].keyHash = "00";
    assert.strictEqual((await validateDirectory(await sign(admin.pair.privateKey, d), [admin.pub], 0)).ok, false);
  });
});

describe("validateProfile", () => {
  it("accepts a newer profile signed by the member and rejects others", async () => {
    const member = await signingKeyPair();
    const other = await signingKeyPair();
    const row = { keyHash: "abc", signingPublicKey: member.pub };
    const profile = { type: "relay-profile", keyHash: "abc", name: "Ana", updatedAt: 10 };
    assert.ok((await validateProfile(await sign(member.pair.privateKey, profile), row, 5)).ok);
    assert.strictEqual((await validateProfile(await sign(member.pair.privateKey, profile), row, 10)).ok, false);
    assert.strictEqual((await validateProfile(await sign(other.pair.privateKey, profile), row, 0)).ok, false);
  });
});
