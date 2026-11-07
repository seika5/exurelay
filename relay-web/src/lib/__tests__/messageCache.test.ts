/**
 * Encrypted local message cache: round trip, other keys can't read it, clearing, retention.
 */

import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { appCacheKey, deleteMessages, expired, loadCache, loadGroupInfo, saveGroupInfo, saveMeta, saveMessages, wipeCache, type CachedMessage } from "../messageCache";
import { CACHE_MESSAGES, run } from "../keystore";

const msg = (id: string, expiresAt = Date.now() + 86_400_000): CachedMessage => ({
  message: { messageId: id, senderKeyHash: "aa", sentAt: 1, type: "text", body: `hello ${id}` },
  expiresAt,
});

/** Stored keys come back as copies, so compare by whether one decrypts what the other encrypted. */
async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const iv = new Uint8Array(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, a, new Uint8Array([1, 2, 3]));
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, b, ct).then(() => true, () => false);
}

describe("message cache", () => {
  it("keeps messages and the cursor encrypted, per identity", async () => {
    const key = await appCacheKey("ana");
    expect(await sameKey(await appCacheKey("ana"), key)).toBe(true);
    await saveMessages("ana", key, [msg("m1"), msg("m2")]);
    await saveMeta("ana", key, { cursor: "42", read: { "dm:x": 5 } });
    const loaded = await loadCache("ana", key);
    expect(loaded.cursor).toBe("42");
    expect(loaded.read).toEqual({ "dm:x": 5 });
    expect(loaded.messages.map((m) => m.message.messageId).sort()).toEqual(["m1", "m2"]);

    // Nothing readable at rest: no plaintext in the stored records.
    const raw = await run<{ ct: Uint8Array }[]>("readonly", (s) => s.getAll(), CACHE_MESSAGES);
    expect(raw.some((r) => new TextDecoder().decode(r.ct).includes("hello"))).toBe(false);

    // Another identity sees nothing; a wrong key reads nothing.
    expect((await loadCache("bob", await appCacheKey("bob"))).messages).toHaveLength(0);
    const wrong = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const unreadable = await loadCache("ana", wrong);
    expect(unreadable.messages).toHaveLength(0);
    expect(unreadable.cursor).toBe("0");
  });

  it("clears one message, everything, or everything plus sync state and key", async () => {
    const key = await appCacheKey("cleo");
    await saveMessages("cleo", key, [msg("a"), msg("b"), msg("c")]);
    await saveMeta("cleo", key, { cursor: "7", read: {} });
    await deleteMessages("cleo", ["a"]);
    expect((await loadCache("cleo", key)).messages).toHaveLength(2);

    await wipeCache("cleo", "messages");
    const afterMessages = await loadCache("cleo", key);
    expect(afterMessages.messages).toHaveLength(0);
    expect(afterMessages.cursor).toBe("7");

    await wipeCache("cleo", "sync");
    expect((await loadCache("cleo", key)).cursor).toBe("0");
    expect(await sameKey(await appCacheKey("cleo"), key)).toBe(true);

    await wipeCache("cleo", "all");
    expect(await sameKey(await appCacheKey("cleo"), key)).toBe(false);
  });

  it("retention counts from the blob's expiry", () => {
    const now = 1_000 * 86_400_000;
    expect(expired(msg("x", now - 6 * 86_400_000), 7, now)).toBe(false);
    expect(expired(msg("x", now - 8 * 86_400_000), 7, now)).toBe(true);
  });
});

describe("group names and pictures kept on the device", () => {
  it("round-trip encrypted, survive saving the sync state, and go when the identity leaves", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const other = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const info = { "group:g1": { name: "Trio", nameAt: 5, icon: "data:image/png;base64,AAAA", iconAt: 6 } };
    await saveGroupInfo("own-g", key, info);
    await saveMeta("own-g", key, { cursor: "3", read: {} });
    expect(await loadGroupInfo("own-g", key)).toEqual(info);
    expect(await loadGroupInfo("own-g", other)).toEqual({});
    await wipeCache("own-g", "sync");
    expect(await loadGroupInfo("own-g", key)).toEqual(info);
    await wipeCache("own-g", "all");
    expect(await loadGroupInfo("own-g", key)).toEqual({});
  });
});
