/**
 * Linked devices: certificates and unlinks must be signed by one of the member's devices.
 * Run: node --test src/lib/__tests__/devices.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { webcrypto } from "crypto";
import { validateDeviceCert, validateDeviceRevoke } from "../devices.js";
import { keyHashOf } from "../signed.js";

const subtle = webcrypto.subtle;
const b64 = (buf) => Buffer.from(buf).toString("base64");
async function signing() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { pair, pub: b64(await subtle.exportKey("raw", pair.publicKey)) };
}
async function ecdhPub() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return b64(await subtle.exportKey("raw", pair.publicKey));
}
async function sign(privateKey, obj) {
  const body = JSON.stringify(obj);
  return { body, signature: b64(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(body))) };
}

describe("linked devices", () => {
  it("certifies a device signed by the member or one of their devices, and nobody else", async () => {
    const [primary, laptop, stranger, phone] = await Promise.all([signing(), signing(), signing(), signing()]);
    const ecdh = await ecdhPub();
    const cert = (by, extra = {}) =>
      sign(by.pair.privateKey, { type: "relay-device", member: "m1", ecdh, sig: phone.pub, name: "Phone", addedAt: 1, signer: by.pub, ...extra });
    const free = async () => false;

    const ok = await validateDeviceCert(await cert(primary), [primary.pub, laptop.pub], free);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.device.keyHash, keyHashOf(ecdh));
    assert.strictEqual((await validateDeviceCert(await cert(laptop), [primary.pub, laptop.pub], free)).ok, true);
    assert.match((await validateDeviceCert(await cert(stranger), [primary.pub, laptop.pub], free)).error, /not signed/);
    // Claiming to be signed by the member while signed by someone else.
    const forged = await sign(stranger.pair.privateKey, JSON.parse((await cert(primary)).body));
    assert.match((await validateDeviceCert(forged, [primary.pub], free)).error, /not signed/);
    assert.match((await validateDeviceCert(await cert(primary), [primary.pub], async () => true)).error, /already in use/);
    assert.match((await validateDeviceCert(await cert(primary, { name: "" }), [primary.pub], free)).error, /name/);
  });

  it("unlinks only the member's own devices, signed by one of them", async () => {
    const [primary, stranger] = await Promise.all([signing(), signing()]);
    const devices = [{ keyHash: "d1" }];
    const revoke = (by, keyHash = "d1") => sign(by.pair.privateKey, { type: "relay-device-revoke", member: "m1", keyHash, revokedAt: 1, signer: by.pub });
    assert.strictEqual((await validateDeviceRevoke(await revoke(primary), [primary.pub], devices)).ok, true);
    assert.match((await validateDeviceRevoke(await revoke(stranger), [primary.pub], devices)).error, /not signed/);
    assert.match((await validateDeviceRevoke(await revoke(primary, "m1"), [primary.pub], devices)).error, /not one of/);
  });
});
