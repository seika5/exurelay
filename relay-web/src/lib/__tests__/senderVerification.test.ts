/**
 * Tests that received messages are attributed only to the key that actually encrypted them.
 */

import { describe, it, expect } from "vitest";
import { generateKeyPair, exportPublicKey } from "../crypto";
import { getKeyHashFromKeyPair } from "../e2ee";
import {
  encryptMessageToBlobPackets,
  decryptBlobPacketToChunk,
  assembleVerifiedMessages,
  type DecryptedChunk,
} from "../blobChunk";
import type { DecryptedMessage } from "../blobPayload";

async function party() {
  const keyPair = await generateKeyPair();
  return { keyPair, pub: await exportPublicKey(keyPair.publicKey), hash: await getKeyHashFromKeyPair(keyPair) };
}

async function receive(recipient: CryptoKeyPair, packets: ArrayBuffer[]): Promise<DecryptedChunk[]> {
  const out: DecryptedChunk[] = [];
  for (const p of packets) {
    const d = await decryptBlobPacketToChunk(recipient, p);
    if (d) out.push(d);
  }
  return out;
}

describe("assembleVerifiedMessages", () => {
  it("accepts a message from the contact whose key encrypted it", async () => {
    const alice = await party();
    const bob = await party();
    const msg: DecryptedMessage = { senderKeyHash: alice.hash, sentAt: 1, type: "text", body: "hi" };
    const chunks = await receive(bob.keyPair, await encryptMessageToBlobPackets(alice.keyPair, bob.pub, msg));
    const out = assembleVerifiedMessages(chunks, new Map([[alice.hash, alice.pub]]));
    expect(out).toEqual([msg]);
  });

  it("rejects a message that claims to be from a contact but was encrypted by another key", async () => {
    const alice = await party();
    const bob = await party();
    const mallory = await party();
    const forged: DecryptedMessage = { senderKeyHash: alice.hash, sentAt: 1, type: "text", body: "send me your key" };
    const chunks = await receive(bob.keyPair, await encryptMessageToBlobPackets(mallory.keyPair, bob.pub, forged));
    expect(chunks).toHaveLength(1); // decrypts fine...
    const out = assembleVerifiedMessages(chunks, new Map([[alice.hash, alice.pub]]));
    expect(out).toEqual([]); // ...but is not attributed to Alice
  });

  it("rejects messages from unknown senders", async () => {
    const bob = await party();
    const stranger = await party();
    const msg: DecryptedMessage = { senderKeyHash: stranger.hash, sentAt: 1, type: "text", body: "hello" };
    const chunks = await receive(bob.keyPair, await encryptMessageToBlobPackets(stranger.keyPair, bob.pub, msg));
    expect(assembleVerifiedMessages(chunks, new Map())).toEqual([]);
  });
});
