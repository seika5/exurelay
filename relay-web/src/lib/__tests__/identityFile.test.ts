/**
 * Passphrase-encrypted identity file: round trip, wrong passphrase, tampering, settings rewrites.
 */

import { describe, it, expect } from "vitest";
import { exportPrivateKey, exportPublicKey, generateKeyPair, generateSigningKeyPair, importIdentityKeys } from "../crypto";
import { createIdentityFile, openIdentityFile, rewriteSettings, WrongPassphraseError, type IdentityKeys } from "../identityFile";

// Lowest count the reader accepts, to keep the tests fast.
const ITER = 100_000;
const PASS = "correct horse battery";

async function newKeys(): Promise<IdentityKeys> {
  const ecdh = await generateKeyPair(true);
  const sig = await generateSigningKeyPair(true);
  return {
    server: "https://relay.example.com",
    ecdhPublic: await exportPublicKey(ecdh.publicKey),
    ecdhPrivate: await exportPrivateKey(ecdh.privateKey),
    signingPublic: await exportPublicKey(sig.publicKey),
    signingPrivate: await exportPrivateKey(sig.privateKey),
  };
}

describe("identity file", () => {
  it("round-trips, and the imported keys work but can't be exported", async () => {
    const keys = await newKeys();
    const settings = { myName: "Ana ✨", contactSettings: [{ keyHash: "bb", nickname: "Bobby", volume: 40 }] };
    const { bytes } = await createIdentityFile(keys, settings, PASS, ITER);
    const opened = await openIdentityFile(bytes, PASS);
    expect(opened.keys).toEqual(keys);
    expect(opened.settings).toEqual(settings);

    const { signingKeyPair } = await importIdentityKeys(opened.keys);
    expect(signingKeyPair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("jwk", signingKeyPair.privateKey)).rejects.toThrow();
  });

  it("refuses a wrong passphrase, a too-short one, and any edited byte", async () => {
    const { bytes } = await createIdentityFile(await newKeys(), { myName: "Ana", contactSettings: [] }, PASS, ITER);
    await expect(openIdentityFile(bytes, "wrong passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(createIdentityFile(await newKeys(), { myName: "Ana", contactSettings: [] }, "short", ITER)).rejects.toThrow(/at least/);
    // Flip a salt byte (header), then a ciphertext byte near the end (settings).
    for (const i of [20, bytes.length - 5]) {
      const bad = bytes.slice();
      bad[i] ^= 1;
      await expect(openIdentityFile(bad, PASS)).rejects.toBeInstanceOf(WrongPassphraseError);
    }
    await expect(openIdentityFile(new TextEncoder().encode("not a file"), PASS)).rejects.toThrow(/isn't an Exurelay identity file/);
  });

  it("rewrites settings without the passphrase and leaves the keys section untouched", async () => {
    const keys = await newKeys();
    const { bytes, session } = await createIdentityFile(keys, { myName: "Ana", contactSettings: [] }, PASS, ITER);
    const next = await rewriteSettings(session, { myName: "Ana B.", contactSettings: [{ keyHash: "cc", volume: 70 }] });
    const opened = await openIdentityFile(next, PASS);
    expect(opened.keys).toEqual(keys);
    expect(opened.settings.myName).toBe("Ana B.");
    expect(next.slice(0, session.header.length + session.keysSection.length)).toEqual(
      bytes.slice(0, session.header.length + session.keysSection.length)
    );
  });

  it("derives the same cache key every time the file is unlocked", async () => {
    const { bytes, session } = await createIdentityFile(await newKeys(), { myName: "Ana", contactSettings: [] }, PASS, ITER);
    const iv = new Uint8Array(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, session.cacheKey, new TextEncoder().encode("cached"));
    const reopened = await openIdentityFile(bytes, PASS);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, reopened.session.cacheKey, ct);
    expect(new TextDecoder().decode(pt)).toBe("cached");
  });

  it("the settings key kept in memory can't decrypt the keys section", async () => {
    const { session } = await createIdentityFile(await newKeys(), { myName: "Ana", contactSettings: [] }, PASS, ITER);
    const iv = session.keysSection.slice(0, 12);
    const ct = session.keysSection.slice(16);
    const additionalData = new Uint8Array([...session.header, ...new TextEncoder().encode("keys")]);
    await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, session.settingsKey, ct)).rejects.toThrow();
  });
});
