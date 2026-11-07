/**
 * Call intros: only someone with the room secret opens one, and it only counts if it's fresh, names this room and the
 * socket it came from, and is signed by a current device of a member allowed in the call.
 */
import { describe, it, expect } from "vitest";
import { exportPublicKey, generateSigningKeyPair } from "../crypto";
import { INTRO_MAX_SKEW_MS, introKey, isRoomKey, newRoomKey, openIntro, sealIntro } from "../callIntro";

const ROOM = "room-AAAAAAAAAAAAAAAAAAAAAA";

async function device(member: string, device: string) {
  const keys = await generateSigningKeyPair();
  return { member, device, keys, sig: await exportPublicKey(keys.publicKey) };
}

describe("call intros", () => {
  it("room keys are 32 random bytes, base64url", () => {
    const a = newRoomKey();
    expect(isRoomKey(a)).toBe(true);
    expect(a).not.toBe(newRoomKey());
    expect(isRoomKey("short")).toBe(false);
    expect(isRoomKey(undefined)).toBe(false);
  });

  it("open for peers with the room secret, from the socket they name, signed by a current device", async () => {
    const ana = await device("ana", "ana-phone");
    const roomKey = newRoomKey();
    const key = await introKey(roomKey, ROOM);
    // Only current devices of members allowed in this call have a signer.
    const signerFor = (member: string, dev: string) => (member === "ana" && dev === "ana-phone" ? ana.sig : undefined);
    const sealed = await sealIntro(key, ana.keys.privateKey, { roomId: ROOM, socket: "sock-a", member: "ana", device: "ana-phone" }, 1000);

    expect(await openIntro(key, sealed, { roomId: ROOM, from: "sock-a", signerFor, now: 1000 })).toEqual({ member: "ana", device: "ana-phone" });
    // Without the room secret, or with another room's, it doesn't open.
    expect(await openIntro(await introKey(newRoomKey(), ROOM), sealed, { roomId: ROOM, from: "sock-a", signerFor, now: 1000 })).toBeNull();
    const other = "room-BBBBBBBBBBBBBBBBBBBBBB";
    expect(await openIntro(await introKey(roomKey, other), sealed, { roomId: other, from: "sock-a", signerFor, now: 1000 })).toBeNull();
    // Relabelled as another socket (the server replaying it), or stale.
    expect(await openIntro(key, sealed, { roomId: ROOM, from: "sock-x", signerFor, now: 1000 })).toBeNull();
    expect(await openIntro(key, sealed, { roomId: ROOM, from: "sock-a", signerFor, now: 1000 + INTRO_MAX_SKEW_MS + 1 })).toBeNull();
    expect(await openIntro(key, sealed, { roomId: ROOM, from: "sock-a", signerFor, now: 1000 - INTRO_MAX_SKEW_MS - 1 })).toBeNull();
    // Removed or not in this conversation: no signer.
    expect(await openIntro(key, sealed, { roomId: ROOM, from: "sock-a", signerFor: () => undefined, now: 1000 })).toBeNull();
    expect(await openIntro(key, "garbage", { roomId: ROOM, from: "sock-a", signerFor, now: 1000 })).toBeNull();
  });

  it("refuse a member with the room secret claiming to be someone else", async () => {
    const ana = await device("ana", "ana-phone");
    const eve = await device("eve", "eve-laptop");
    const key = await introKey(newRoomKey(), ROOM);
    const signerFor = (member: string, dev: string) =>
      member === "ana" && dev === "ana-phone" ? ana.sig : member === "eve" && dev === "eve-laptop" ? eve.sig : undefined;
    // Eve signs with her own key but names Ana's device.
    const forged = await sealIntro(key, eve.keys.privateKey, { roomId: ROOM, socket: "sock-e", member: "ana", device: "ana-phone" }, 1000);
    expect(await openIntro(key, forged, { roomId: ROOM, from: "sock-e", signerFor, now: 1000 })).toBeNull();
    // Her own intro is fine.
    const own = await sealIntro(key, eve.keys.privateKey, { roomId: ROOM, socket: "sock-e", member: "eve", device: "eve-laptop" }, 1000);
    expect(await openIntro(key, own, { roomId: ROOM, from: "sock-e", signerFor, now: 1000 })).toEqual({ member: "eve", device: "eve-laptop" });
  });
});
