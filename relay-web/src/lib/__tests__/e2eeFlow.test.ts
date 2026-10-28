/**
 * Tests for the high-level E2EE flow: encryptForRecipient / decryptFromSender.
 * Payload includes senderPublicKey so recipient can attribute and decrypt with sender's public.
 */

import { describe, it, expect } from "vitest";
import {
  encryptForRecipient,
  decryptFromSender,
  getKeyHashFromKeyPair,
  type EncryptedBlobPayload,
} from "../e2ee";

describe("E2EE flow (encryptForRecipient / decryptFromSender)", () => {
  it("encrypts and decrypts text message between two parties", async () => {
    const alice = await import("../crypto").then((c) => c.generateKeyPair());
    const bob = await import("../crypto").then((c) => c.generateKeyPair());
    const alicePub = await import("../crypto").then((c) => c.exportPublicKey(alice.publicKey));
    const bobPub = await import("../crypto").then((c) => c.exportPublicKey(bob.publicKey));

    const payload = { senderKeyHash: "a", sentAt: 1, type: "text" as const, body: "Hello Bob" };
    const encrypted = await encryptForRecipient(alice, bobPub, payload);
    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.senderPublicKey).toBe(alicePub);

    const decrypted = await decryptFromSender(bob, encrypted.senderPublicKey, encrypted.ciphertext);
    expect(decrypted).toEqual(payload);
  });

  it("encrypts and decrypts file payload with filename and size", async () => {
    const alice = await import("../crypto").then((c) => c.generateKeyPair());
    const bob = await import("../crypto").then((c) => c.generateKeyPair());
    const bobPub = await import("../crypto").then((c) => c.exportPublicKey(bob.publicKey));

    const payload = {
      senderKeyHash: "a",
      sentAt: 1,
      type: "file" as const,
      body: "base64encodedfiledata",
      filename: "secret.pdf",
      fileSize: 12345,
    };
    const encrypted = await encryptForRecipient(alice, bobPub, payload);
    const decrypted = await decryptFromSender(bob, encrypted.senderPublicKey, encrypted.ciphertext);
    expect(decrypted).toEqual(payload);
  });

  it("decrypt fails with wrong recipient key", async () => {
    const alice = await import("../crypto").then((c) => c.generateKeyPair());
    const bob = await import("../crypto").then((c) => c.generateKeyPair());
    const eve = await import("../crypto").then((c) => c.generateKeyPair());
    const bobPub = await import("../crypto").then((c) => c.exportPublicKey(bob.publicKey));
    const alicePub = await import("../crypto").then((c) => c.exportPublicKey(alice.publicKey));

    const encrypted = await encryptForRecipient(alice, bobPub, { senderKeyHash: "a", sentAt: 1, type: "text", body: "Secret" });
    await expect(
      decryptFromSender(eve, alicePub, encrypted.ciphertext)
    ).rejects.toThrow();
  });

  it("getKeyHashFromKeyPair returns SHA-256 hex of public key", async () => {
    const alice = await import("../crypto").then((c) => c.generateKeyPair());
    const hash = await getKeyHashFromKeyPair(alice);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const crypto = await import("../crypto");
    const alicePubB64 = await crypto.exportPublicKey(alice.publicKey);
    const expected = await crypto.sha256Hex(alicePubB64);
    expect(hash).toBe(expected);
  });
});
