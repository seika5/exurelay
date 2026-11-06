/**
 * Push payloads: encrypted device to device, opened only by the device they're for, and only while recent.
 */
import { describe, it, expect } from "vitest";
import { exportPublicKey, generateKeyPair } from "../crypto";
import { openPush, sameKey, sealPush, PUSH_MAX_AGE_MS } from "../push";

async function device(keyHash: string) {
  const keyPair = await generateKeyPair();
  return { keyHash, keyPair, publicKey: await exportPublicKey(keyPair.publicKey) };
}

describe("push payloads", () => {
  it("open only on the recipient device, from the sender's key, while recent", async () => {
    const [ana, bobPhone, bobLaptop] = await Promise.all([device("ana-d"), device("bob-p"), device("bob-l")]);
    const content = { kind: "mention" as const, member: "ana", group: "Trip", ts: 1000 };
    const payload = await sealPush(ana.keyPair.privateKey, ana.keyHash, bobPhone, content);
    expect(payload).not.toContain("Trip");

    expect(await openPush(bobPhone.keyPair.privateKey, bobPhone.keyHash, ana.publicKey, payload, 2000)).toEqual(content);
    // Another device (even Bob's own), the wrong sender key, or too late: nothing.
    expect(await openPush(bobLaptop.keyPair.privateKey, bobLaptop.keyHash, ana.publicKey, payload, 2000)).toBeNull();
    expect(await openPush(bobPhone.keyPair.privateKey, bobPhone.keyHash, bobLaptop.publicKey, payload, 2000)).toBeNull();
    expect(await openPush(bobPhone.keyPair.privateKey, bobPhone.keyHash, ana.publicKey, payload, 1000 + PUSH_MAX_AGE_MS + 1)).toBeNull();
  });
});

describe("sameKey", () => {
  const key = "BHfKpxj8qiu1915eWGbuICIKAdPhzJL5Lgm2IB64TwwohDZDi6U-PIZ5S5ReFnxtgMxXp2n_ariJWNGgskLhOyU";
  const bytes = (s: string) => Uint8Array.from(atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const sub = (k: Uint8Array | null) => ({ options: { applicationServerKey: k ? k.buffer : null } }) as unknown as PushSubscription;
  it("matches the key the subscription was made with", () => {
    expect(sameKey(sub(bytes(key)), key)).toBe(true);
  });
  it("spots a subscription made with another server key", () => {
    const other = bytes(key);
    other[10] ^= 1;
    expect(sameKey(sub(other), key)).toBe(false);
  });
  it("assumes it's right when the browser doesn't say", () => {
    expect(sameKey(sub(null), key)).toBe(true);
  });
});
