/**
 * Sealed call signaling: only the named peer opens a signal, in one direction and one room, and only while fresh.
 */
import { describe, it, expect } from "vitest";
import { exportPublicKey, generateKeyPair } from "../crypto";
import { openSignal, sealSignal, signalKey, SIGNAL_MAX_SKEW_MS } from "../callSignal";

async function member() {
  const keyPair = await generateKeyPair();
  return { keyPair, pub: await exportPublicKey(keyPair.publicKey) };
}

describe("call signals", () => {
  it("open for the peer they're sealed to, in that room and direction, while fresh", async () => {
    const [ana, bob, eve] = await Promise.all([member(), member(), member()]);
    const offer = { type: "offer", sdp: { type: "offer", sdp: "v=0 fingerprint:sha-256 AA:BB" } };
    const sealed = await sealSignal(await signalKey(ana.keyPair.privateKey, bob.pub, "room-x", "ana", "bob"), offer, 1000);

    // Bob, with the same derivation from his side, opens it.
    expect(await openSignal(await signalKey(bob.keyPair.privateKey, ana.pub, "room-x", "ana", "bob"), sealed, 1000)).toEqual(offer);
    // Not in another room, not in the other direction, not for Eve, not when stale.
    expect(await openSignal(await signalKey(bob.keyPair.privateKey, ana.pub, "room-y", "ana", "bob"), sealed, 1000)).toBeNull();
    expect(await openSignal(await signalKey(bob.keyPair.privateKey, ana.pub, "room-x", "bob", "ana"), sealed, 1000)).toBeNull();
    expect(await openSignal(await signalKey(eve.keyPair.privateKey, ana.pub, "room-x", "ana", "eve"), sealed, 1000)).toBeNull();
    expect(
      await openSignal(await signalKey(bob.keyPair.privateKey, ana.pub, "room-x", "ana", "bob"), sealed, 1000 + SIGNAL_MAX_SKEW_MS + 1)
    ).toBeNull();
  });
});
