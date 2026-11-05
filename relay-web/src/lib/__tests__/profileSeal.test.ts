import { describe, it, expect } from "vitest";
import { generateKeyPair } from "../crypto";
import { openProfile, sealProfile, type ReceivedCopy } from "../profileSeal";

const A = "a".repeat(64); // author (member)
const S = "s".repeat(64); // sending device
const R = "r".repeat(64); // recipient device

async function setup() {
  const [sender, recipient, other] = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()]);
  return { sender, recipient, other };
}
const received = (author: string, sender: string, c: { nonce: string; ciphertext: string; updatedAt: number }): ReceivedCopy => ({
  author,
  sender,
  ...c,
});

describe("sealed profiles", () => {
  it("opens on the recipient device, with the name and device names", async () => {
    const { sender, recipient } = await setup();
    const payload = { name: "Ana", updatedAt: 1000, devices: { [S]: "Phone", [R]: "MacBook" } };
    const c = await sealProfile(sender.privateKey, recipient.publicKey, { author: A, sender: S, recipient: R }, payload);
    expect(c.recipient).toBe(R);
    expect(await openProfile(recipient.privateKey, sender.publicKey, R, received(A, S, c))).toEqual(payload);
  });

  it("doesn't open for another device, another author or sender, or a changed date", async () => {
    const { sender, recipient, other } = await setup();
    const c = await sealProfile(sender.privateKey, recipient.publicKey, { author: A, sender: S, recipient: R }, { name: "Ana", updatedAt: 1000 });
    expect(await openProfile(other.privateKey, sender.publicKey, R, received(A, S, c))).toBeNull();
    expect(await openProfile(recipient.privateKey, other.publicKey, R, received(A, S, c))).toBeNull();
    expect(await openProfile(recipient.privateKey, sender.publicKey, "x".repeat(64), received(A, S, c))).toBeNull();
    expect(await openProfile(recipient.privateKey, sender.publicKey, R, received("b".repeat(64), S, c))).toBeNull();
    expect(await openProfile(recipient.privateKey, sender.publicKey, R, received(A, "t".repeat(64), c))).toBeNull();
    expect(await openProfile(recipient.privateKey, sender.publicKey, R, received(A, S, { ...c, updatedAt: 2000 }))).toBeNull();
  });

  it("carries introductions, padded like device names", async () => {
    const { sender, recipient } = await setup();
    const ids = { author: A, sender: S, recipient: R };
    const payload = { name: "Ana", updatedAt: 5, intros: ["RELAY-ENROLL:abc", "RELAY-ENROLL:def"] };
    const c = await sealProfile(sender.privateKey, recipient.publicKey, ids, payload);
    expect(await openProfile(recipient.privateKey, sender.publicKey, R, received(A, S, c))).toEqual(payload);
    const one = await sealProfile(sender.privateKey, recipient.publicKey, ids, { name: "Ana", updatedAt: 5, intros: ["RELAY-ENROLL:abc"] });
    expect(one.ciphertext.length).toBe(c.ciphertext.length);
  });

  it("is the same size whatever the name's length", async () => {
    const { sender, recipient } = await setup();
    const ids = { author: A, sender: S, recipient: R };
    const short = await sealProfile(sender.privateKey, recipient.publicKey, ids, { name: "Al", updatedAt: 1 });
    const long = await sealProfile(sender.privateKey, recipient.publicKey, ids, { name: "Alexandria Montgomery-Smythe", updatedAt: 1 });
    expect(short.ciphertext.length).toBe(long.ciphertext.length);
    const withDevices = await sealProfile(sender.privateKey, recipient.publicKey, ids, { name: "Al", updatedAt: 1, devices: { [S]: "Phone" } });
    const withMore = await sealProfile(sender.privateKey, recipient.publicKey, ids, { name: "Al", updatedAt: 1, devices: { [S]: "Phone", [R]: "MacBook Pro" } });
    expect(withDevices.ciphertext.length).toBe(withMore.ciphertext.length);
  });
});
