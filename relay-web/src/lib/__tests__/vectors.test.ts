/**
 * Protocol test vectors (DESIGN.md §9 "Fork and deploy"). Recorded outputs of the wire formats, made once with
 * fixed test keys: today's code must still open every one. If this fails, a change broke compatibility with
 * every other Relay build (the official app, other forks); bump the protocol instead of editing the vectors.
 *
 * Regenerate (only for a deliberate new protocol version): GENERATE_VECTORS=1 npx vitest run vectors
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { exportPrivateKey, exportPublicKey, generateKeyPair, generateSigningKeyPair } from "../crypto";
import { getKeyHashFromKeyPair } from "../e2ee";
import { Opener, sealSend, randomBytes } from "../sealed";
import { openPush, sealPush } from "../push";
import { openSignal, sealSignal, signalKey } from "../callSignal";
import { createIdentityFile, openIdentityFile } from "../identityFile";

const FILE = join(__dirname, "vectors", "protocol-v2.json");
const S = 16384;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

type Party = { keyHash: string; pub: string; priv: JsonWebKey };

async function party(): Promise<Party & { pair: CryptoKeyPair }> {
  const pair = await generateKeyPair(true);
  return { pair, keyHash: await getKeyHashFromKeyPair(pair), pub: await exportPublicKey(pair.publicKey), priv: await exportPrivateKey(pair.privateKey) };
}

const importPriv = (jwk: JsonWebKey) =>
  crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits", "deriveKey"]);

async function generate() {
  const [ana, bob] = await Promise.all([party(), party()]);
  const text = JSON.stringify({ messageId: "v-1", senderKeyHash: ana.keyHash, sentAt: 1, type: "text", body: "hello from the vectors" });
  const big = b64(randomBytes(2 * S));
  const file = JSON.stringify({ messageId: "v-2", senderKeyHash: ana.keyHash, sentAt: 2, type: "file", body: big, filename: "v.bin" });
  const seal = (payload: string, decoys: number) =>
    sealSend({
      senderKeyPair: ana.pair,
      senderKeyHash: ana.keyHash,
      recipients: [{ keyHash: bob.keyHash, publicKey: bob.pub }, { keyHash: ana.keyHash, publicKey: ana.pub }],
      payload: new TextEncoder().encode(payload),
      blobSize: S,
      maxDecoys: decoys,
    });
  const blobs = [...(await seal(text, 2)), ...(await seal(file, 1))];
  const push = await sealPush(ana.pair.privateKey, ana.keyHash, { keyHash: bob.keyHash, publicKey: bob.pub }, { kind: "mention", member: ana.keyHash, group: "Trip", ts: 1 });
  const signal = await sealSignal(await signalKey(ana.pair.privateKey, bob.pub, "room-vectors", ana.keyHash, bob.keyHash), { type: "offer", sdp: "v=0" }, 1);
  const sig = await generateSigningKeyPair(true);
  const identity = await createIdentityFile(
    { server: "https://relay.example", ecdhPublic: ana.pub, ecdhPrivate: ana.priv, signingPublic: await exportPublicKey(sig.publicKey), signingPrivate: await exportPrivateKey(sig.privateKey) },
    { myName: "Ana", contactSettings: [] },
    "vectors passphrase",
    100_000
  );
  const strip = (p: Party & { pair: CryptoKeyPair }): Party => ({ keyHash: p.keyHash, pub: p.pub, priv: p.priv });
  writeFileSync(
    FILE,
    JSON.stringify(
      {
        note: "Relay protocol v2 test vectors. Test keys only. Regenerate only for a new protocol version.",
        blobSize: S,
        ana: strip(ana),
        bob: strip(bob),
        blobs: blobs.map(b64),
        expected: [text, file],
        push: { payload: push, content: { kind: "mention", member: ana.keyHash, group: "Trip", ts: 1 } },
        signal: { sealed: signal, room: "room-vectors", data: { type: "offer", sdp: "v=0" }, at: 1 },
        identityFile: { bytes: b64(identity.bytes), passphrase: "vectors passphrase", myName: "Ana" },
      },
      null,
      1
    )
  );
}

describe("protocol v2 vectors", () => {
  it("still open with today's code", async () => {
    if (process.env.GENERATE_VECTORS) await generate();
    expect(existsSync(FILE), "protocol-v2.json is missing: it's committed with the code").toBe(true);
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    const bobPriv = await importPriv(v.bob.priv);
    const bobPair = { privateKey: bobPriv, publicKey: bobPriv } as CryptoKeyPair; // only the private key is used

    // Sealed sends: Bob opens both (one with continuation blobs), both from Ana, payloads byte for byte.
    const opener = new Opener(bobPair, v.bob.keyHash);
    await opener.setMembers(new Map([[v.ana.keyHash, v.ana.pub], [v.bob.keyHash, v.bob.pub]]));
    const opened = [];
    for (const [i, b] of (v.blobs as string[]).entries()) {
      const payload = unb64(b);
      expect(payload.length).toBe(v.blobSize);
      const o = await opener.add({ seq: String(i + 1), expiresAt: Date.now() + 86_400_000, payload });
      if (o) opened.push(o);
    }
    expect(opened.map((o) => o.senderKeyHash)).toEqual([v.ana.keyHash, v.ana.keyHash]);
    expect(opened.map((o) => new TextDecoder().decode(o.payload))).toEqual(v.expected);

    // Push payload, call signal, identity file.
    expect(await openPush(bobPriv, v.bob.keyHash, v.ana.pub, v.push.payload, 2)).toEqual(v.push.content);
    const key = await signalKey(bobPriv, v.ana.pub, v.signal.room, v.ana.keyHash, v.bob.keyHash);
    expect(await openSignal(key, v.signal.sealed, v.signal.at)).toEqual(v.signal.data);
    const file = await openIdentityFile(unb64(v.identityFile.bytes), v.identityFile.passphrase);
    expect(file.settings.myName).toBe(v.identityFile.myName);
    expect(file.keys.ecdhPublic).toBe(v.ana.pub);
  });
});
