/**
 * Protocol v2 sealed sends: only recipients open them, the sender is proven, blobs carry no structure, decoys and
 * other people's blobs are ignored, multi-blob sends reassemble in any order, and tampering is caught.
 */

import { describe, it, expect } from "vitest";
import { exportPublicKey, generateKeyPair } from "../crypto";
import { getKeyHashFromKeyPair } from "../e2ee";
import { maxRecipients, Opener, sealSend, SLOT_LEN, randomBytes, type StoredBlob } from "../sealed";

const S = 16384; // smallest allowed size keeps multi-blob tests quick

async function member() {
  const keyPair = await generateKeyPair();
  return { keyPair, pub: await exportPublicKey(keyPair.publicKey), keyHash: await getKeyHashFromKeyPair(keyPair) };
}
type M = Awaited<ReturnType<typeof member>>;

const stored = (blobs: Uint8Array[], from = 1): StoredBlob[] =>
  blobs.map((payload, i) => ({ seq: String(from + i), expiresAt: Date.now() + 86_400_000, payload }));

async function openerFor(me: M, members: M[]) {
  const o = new Opener(me.keyPair, me.keyHash);
  await o.setMembers(new Map(members.map((m) => [m.keyHash, m.pub])));
  return o;
}

async function openAll(opener: Opener, blobs: StoredBlob[]) {
  const out = [];
  for (const b of blobs) {
    const o = await opener.add(b);
    if (o) out.push(o);
  }
  return out;
}

const seal = (from: M, to: M[], payload: Uint8Array, maxDecoys = 0) =>
  sealSend({ senderKeyPair: from.keyPair, senderKeyHash: from.keyHash, recipients: to.map((m) => ({ keyHash: m.keyHash, publicKey: m.pub })), payload, blobSize: S, maxDecoys });

describe("sealed sends", () => {
  it("recipients (including the sender's self-copy) open it and learn who sent it; others don't", async () => {
    const [alice, bob, carol, eve] = await Promise.all([member(), member(), member(), member()]);
    const everyone = [alice, bob, carol, eve];
    const blobs = await seal(alice, [bob, carol, alice], new TextEncoder().encode("hello group"), 3);
    expect(blobs.every((b) => b.length === S)).toBe(true);
    expect(blobs.length).toBeGreaterThanOrEqual(1);
    expect(blobs.length).toBeLessThanOrEqual(4);

    for (const who of [bob, carol, alice]) {
      const opened = await openAll(await openerFor(who, everyone), stored(blobs));
      expect(opened).toHaveLength(1);
      expect(opened[0].senderKeyHash).toBe(alice.keyHash);
      expect(new TextDecoder().decode(opened[0].payload)).toBe("hello group");
    }
    expect(await openAll(await openerFor(eve, everyone), stored(blobs))).toHaveLength(0);
  });

  it("no blob starts with a curve point or any fixed byte", async () => {
    const [alice, bob] = await Promise.all([member(), member()]);
    const firstBytes = new Set<number>();
    for (let i = 0; i < 40; i++) {
      for (const b of await seal(alice, [bob], new Uint8Array(10), 3)) firstBytes.add(b[0]);
    }
    expect(firstBytes.size).toBeGreaterThan(20);
  });

  it("a large send reassembles whatever the order, with the head after its continuations and traffic in between", async () => {
    const [alice, bob] = await Promise.all([member(), member()]);
    const payload = randomBytes(5 * S + 123);
    const blobs = await seal(alice, [bob, alice], payload);
    expect(blobs.length).toBe(6);
    const shuffled = [...blobs].reverse();
    const mixed = [randomBytes(S), ...shuffled.slice(0, 3), randomBytes(S), ...shuffled.slice(3)];
    const opened = await openAll(await openerFor(bob, [alice, bob]), stored(mixed));
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual(payload);
  });

  it("a send from someone not yet in our member list opens once they're added", async () => {
    const [alice, bob, newbie] = await Promise.all([member(), member(), member()]);
    const opener = await openerFor(bob, [alice, bob]);
    expect(await openAll(opener, stored(await seal(newbie, [bob], new TextEncoder().encode("hi, I'm new"))))).toHaveLength(0);
    const late = await opener.setMembers(new Map([alice, bob, newbie].map((m) => [m.keyHash, m.pub])));
    expect(late).toHaveLength(1);
    expect(late[0].senderKeyHash).toBe(newbie.keyHash);
  });

  it("a send shows its real sender, so a member can't pose as another", async () => {
    const [alice, bob, mallory] = await Promise.all([member(), member(), member()]);
    const opened = await openAll(await openerFor(bob, [alice, bob, mallory]), stored(await seal(mallory, [bob], new TextEncoder().encode("it's alice"))));
    expect(opened[0].senderKeyHash).toBe(mallory.keyHash);
  });

  it("an edited body byte is caught; another recipient's slot doesn't affect yours", async () => {
    const [alice, bob, carol] = await Promise.all([member(), member(), member()]);
    const blobs = await seal(alice, [bob, carol], new TextEncoder().encode("x".repeat(100)));
    const bodyStart = 32 + 2 * SLOT_LEN;
    const carolOpens = async (head: Uint8Array) => openAll(await openerFor(carol, [alice, bob, carol]), stored([head]));

    // The slot pins the body's hash: an edit in the body (by the server, or by Bob, who also knows the message key)
    // makes it unreadable for Carol.
    const body = blobs[0].slice();
    body[bodyStart + 5] ^= 1;
    expect(await carolOpens(body)).toHaveLength(0);

    // Slots are independent: corrupting one of the two still leaves exactly one recipient able to read it.
    const slot = blobs[0].slice();
    slot[32 + 20] ^= 1;
    const bobOpens = await openAll(await openerFor(bob, [alice, bob, carol]), stored([slot]));
    expect((await carolOpens(slot)).length + bobOpens.length).toBe(1);
  });

  it("refuses more recipients than fit in the head blob", async () => {
    const alice = await member();
    const many = Array.from({ length: maxRecipients(S) + 1 }, (_, i) => ({ keyHash: `k${i}`, publicKey: alice.pub }));
    await expect(
      sealSend({ senderKeyPair: alice.keyPair, senderKeyHash: alice.keyHash, recipients: many, payload: new Uint8Array(1), blobSize: S, maxDecoys: 0 })
    ).rejects.toThrow(/Too many recipients/);
  });
});
