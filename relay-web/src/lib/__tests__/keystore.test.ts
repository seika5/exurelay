/**
 * Identities in IndexedDB: keys survive a save/load round trip, stay usable, and can't be exported.
 */

import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { exportPublicKey, generateKeyPair, generateSigningKeyPair } from "../crypto";
import { getKeyHashFromKeyPair } from "../e2ee";
import { deleteIdentity, loadIdentity, saveIdentity, type StoredIdentity } from "../keystore";

async function newIdentity(server: string): Promise<StoredIdentity> {
  const keyPair = await generateKeyPair();
  const signingKeyPair = await generateSigningKeyPair();
  return {
    server,
    keyPair,
    signingKeyPair,
    keyHash: await getKeyHashFromKeyPair(keyPair),
    publicKeyBase64: await exportPublicKey(keyPair.publicKey),
    signingPublicKeyBase64: await exportPublicKey(signingKeyPair.publicKey),
    myName: "Ana",
    contactSettings: [{ keyHash: "bb", nickname: "Bobby", volume: 40 }],
  };
}

describe("keystore", () => {
  it("keeps one identity per server, usable but not exportable after reload", async () => {
    const a = await newIdentity("https://a.example");
    const b = await newIdentity("https://b.example");
    await saveIdentity(a);
    await saveIdentity(b);

    const loaded = await loadIdentity("https://a.example");
    expect(loaded?.keyHash).toBe(a.keyHash);
    expect(loaded?.contactSettings).toEqual(a.contactSettings);
    expect((await loadIdentity("https://b.example"))?.keyHash).toBe(b.keyHash);

    const priv = loaded!.signingKeyPair.privateKey;
    expect(priv.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", priv)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("pkcs8", loaded!.keyPair.privateKey)).rejects.toThrow();

    // Still signs with the stored key, verifiable with the original public key.
    const data = new TextEncoder().encode("hello");
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, data);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, a.signingKeyPair.publicKey, sig, data)).toBe(true);

    await deleteIdentity("https://a.example");
    expect(await loadIdentity("https://a.example")).toBeNull();
    expect(await loadIdentity("https://b.example")).not.toBeNull();
  });
});
