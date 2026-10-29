/**
 * Push payloads: encrypted device to device, opened only by the device they're for, and only while recent.
 */
import { describe, it, expect } from "vitest";
import { exportPublicKey, generateKeyPair } from "../crypto";
import { openPush, sealPush, PUSH_MAX_AGE_MS } from "../push";

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
