/**
 * Unit tests for admin-signed directories and member-signed profiles.
 * Run: node --test src/lib/__tests__/directory.test.js
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { webcrypto } from "crypto";
import { setupCodeMatches, validateDirectory, validateLeave } from "../directory.js";
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

describe("trustedAdmins", () => {
  it("uses the newest directory's admins once it has some, else the env bootstrap keys", async () => {
    const { trustedAdmins } = await import("../directory.js");
    assert.deepStrictEqual(trustedAdmins(null, ["env"]), ["env"]);
    assert.deepStrictEqual(trustedAdmins(JSON.stringify({ admins: [] }), ["env"]), ["env"]);
    assert.deepStrictEqual(trustedAdmins(JSON.stringify({ admins: ["a", "b"] }), ["env"]), ["a", "b"]);
  });
});

describe("validateLeave", () => {
  it("accepts a fresh leave signed by the member for this server, and refuses the last admin", async () => {
    const me = await signingKeyPair();
    const other = await signingKeyPair();
    const ecdh = await ecdhPub();
    const member = { keyHash: keyHashOf(ecdh), signingPublicKey: me.pub };
    const now = 1_700_000_000_000;
    const opts = { publicUrl: "https://relay.example/", now };
    const leave = (fields = {}) =>
      sign(me.pair.privateKey, { type: "relay-leave", keyHash: member.keyHash, server: "https://relay.example", ts: now, ...fields });

    assert.strictEqual((await validateLeave(await leave(), member, [other.pub], opts)).ok, true);
    assert.strictEqual((await validateLeave(await leave(), member, [other.pub, me.pub], opts)).ok, true);
    assert.match((await validateLeave(await leave(), member, [me.pub], opts)).error, /only admin/);
    assert.match((await validateLeave(await leave({ server: "https://evil.example" }), member, [other.pub], opts)).error, /different server/);
    assert.match((await validateLeave(await leave({ ts: now - 10 * 60_000 }), member, [other.pub], opts)).error, /stale/);
    assert.match((await validateLeave(await leave(), null, [other.pub], opts)).error, /not a member/);
    const forged = await sign(other.pair.privateKey, JSON.parse((await leave()).body));
    assert.match((await validateLeave(forged, member, [other.pub], opts)).error, /bad signature/);
  });
});

describe("blob settings", () => {
  it("accepts blobSize and decoys in range and reads the size from the newest directory", async () => {
    const { blobSizeOf, DEFAULT_BLOB_SIZE } = await import("../directory.js");
    const admin = await signingKeyPair();
    const ecdh = await ecdhPub();
    const member = { keyHash: keyHashOf(ecdh), ecdh, sig: admin.pub, enrolledAt: 1 };
    const dir = (extra) =>
      sign(admin.pair.privateKey, { type: "relay-directory", version: 1, issuedAt: 1, signer: admin.pub, members: [member], removed: [], admins: [admin.pub], ...extra });
    assert.strictEqual((await validateDirectory(await dir({ blobSize: 32768, decoys: 0 }), [admin.pub])).ok, true);
    assert.match((await validateDirectory(await dir({ blobSize: 1000 }), [admin.pub])).error, /blobSize/);
    assert.match((await validateDirectory(await dir({ blobSize: 1 << 20 }), [admin.pub])).error, /blobSize/);
    assert.match((await validateDirectory(await dir({ decoys: 17 }), [admin.pub])).error, /decoys/);
    assert.strictEqual(blobSizeOf(JSON.stringify({ blobSize: 32768 })), 32768);
    assert.strictEqual(blobSizeOf(undefined), DEFAULT_BLOB_SIZE);
  });
});

describe("admin devices", () => {
  it("accepts a member's linked device as admin, but not a stranger's key", async () => {
    const admin = await signingKeyPair();
    const laptop = await signingKeyPair();
    const stranger = await signingKeyPair();
    const ecdh = await ecdhPub();
    const member = { keyHash: keyHashOf(ecdh), ecdh, sig: admin.pub, enrolledAt: 1 };
    const dir = (admins) =>
      sign(admin.pair.privateKey, { type: "relay-directory", version: 2, issuedAt: 1, signer: admin.pub, members: [member], removed: [], admins });
    const devicesOf = (k) => (k === member.keyHash ? [laptop.pub] : []);
    assert.strictEqual((await validateDirectory(await dir([laptop.pub]), [admin.pub], 1, devicesOf)).ok, true);
    assert.match((await validateDirectory(await dir([laptop.pub]), [admin.pub], 1)).error, /member or one of their devices/);
    assert.match((await validateDirectory(await dir([stranger.pub]), [admin.pub], 1, devicesOf)).error, /member or one of their devices/);
  });
});

describe("setupCodeMatches", () => {
  it("accepts only the configured code, and nothing when none is configured", () => {
    assert.strictEqual(setupCodeMatches("abc-123", "abc-123"), true);
    assert.strictEqual(setupCodeMatches("abc-123", " abc-123\n"), true);
    assert.strictEqual(setupCodeMatches("abc-123", "abc-124"), false);
    assert.strictEqual(setupCodeMatches("", ""), false);
    assert.strictEqual(setupCodeMatches("", "anything"), false);
    assert.strictEqual(setupCodeMatches("abc-123", undefined), false);
  });
});
