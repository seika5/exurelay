/**
 * Enrollment codes, admin-signed directories, member profiles and the v5 identity file.
 */

import { describe, it, expect } from "vitest";
import { exportPrivateKey, exportPublicKey, generateKeyPair, generateSigningKeyPair } from "../crypto";
import {
  createEnrollmentCode,
  directoryWithMember,
  directoryWithoutMember,
  keyHashOf,
  readEnrollmentCode,
  signRecord,
  verifyDirectory,
  verifyProfiles,
  ENROLLMENT_CODE_TTL_MS,
  type DirectoryMember,
} from "../signed";
import { parseIdentityBinary, writeIdentityBinary } from "../identityBinary";

async function newMember(): Promise<{ ecdh: CryptoKeyPair; signing: CryptoKeyPair; entry: DirectoryMember }> {
  const ecdh = await generateKeyPair();
  const signing = await generateSigningKeyPair();
  const ecdhB64 = await exportPublicKey(ecdh.publicKey);
  return {
    ecdh,
    signing,
    entry: { keyHash: await keyHashOf(ecdhB64), ecdh: ecdhB64, sig: await exportPublicKey(signing.publicKey), enrolledAt: 1 },
  };
}

describe("enrollment codes", () => {
  it("round-trips and carries the newcomer's keys and name", async () => {
    const m = await newMember();
    const code = await createEnrollmentCode(m.ecdh.publicKey, m.signing, "Ana", 1000);
    const r = await readEnrollmentCode(code, 1000 + 60_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.name).toBe("Ana");
      expect(r.keyHash).toBe(m.entry.keyHash);
    }
  });

  it("expires after 3 minutes", async () => {
    const m = await newMember();
    const code = await createEnrollmentCode(m.ecdh.publicKey, m.signing, "Ana", 1000);
    expect((await readEnrollmentCode(code, 1000 + ENROLLMENT_CODE_TTL_MS + 1)).ok).toBe(false);
  });

  it("rejects a code whose keys were swapped after signing", async () => {
    const m = await newMember();
    const attacker = await newMember();
    const code = await createEnrollmentCode(m.ecdh.publicKey, m.signing, "Ana", 1000);
    const env = JSON.parse(atob(code.slice("RELAY-ENROLL:".length)));
    env.body = env.body.replace(m.entry.ecdh, attacker.entry.ecdh);
    const tampered = "RELAY-ENROLL:" + btoa(JSON.stringify(env));
    expect((await readEnrollmentCode(tampered, 1000)).ok).toBe(false);
  });
});

describe("directory", () => {
  it("verifies an admin-signed directory and refuses older versions", async () => {
    const admin = await newMember();
    const bob = await newMember();
    const v1 = directoryWithMember(null, admin.entry.sig, admin.entry, 1);
    const v2 = directoryWithMember(v1, admin.entry.sig, bob.entry, 2);
    const env2 = await signRecord(admin.signing.privateKey, v2);
    const ok = await verifyDirectory(env2, [admin.entry.sig], 1);
    expect(ok.ok).toBe(true);
    const env1 = await signRecord(admin.signing.privateKey, v1);
    expect((await verifyDirectory(env1, [admin.entry.sig], 2)).ok).toBe(false);
  });

  it("refuses a directory not signed by a built-in admin key", async () => {
    const admin = await newMember();
    const rogue = await newMember();
    const d = directoryWithMember(null, rogue.entry.sig, rogue.entry, 1);
    const env = await signRecord(rogue.signing.privateKey, d);
    expect((await verifyDirectory(env, [admin.entry.sig], 0)).ok).toBe(false);
  });

  it("re-enrollment moves the old key to removed; removal does too", async () => {
    const admin = await newMember();
    const bobOld = await newMember();
    const bobNew = await newMember();
    let d = directoryWithMember(null, admin.entry.sig, admin.entry, 1);
    d = directoryWithMember(d, admin.entry.sig, bobOld.entry, 2);
    d = directoryWithMember(d, admin.entry.sig, { ...bobNew.entry, replaces: bobOld.entry.keyHash }, 3);
    expect(d.version).toBe(3);
    expect(d.members.map((m) => m.keyHash)).toEqual([admin.entry.keyHash, bobNew.entry.keyHash]);
    expect(d.removed.map((r) => r.keyHash)).toEqual([bobOld.entry.keyHash]);
    d = directoryWithoutMember(d, admin.entry.sig, bobNew.entry.keyHash, 4);
    expect(d.members).toHaveLength(1);
    expect(d.removed).toHaveLength(2);
  });
});

describe("profiles", () => {
  it("keeps names signed by the member's own key, newest first", async () => {
    const ana = await newMember();
    const mallory = await newMember();
    const sign = (who: typeof ana, name: string, updatedAt: number) =>
      signRecord(who.signing.privateKey, { type: "relay-profile", keyHash: ana.entry.keyHash, name, updatedAt });
    const names = await verifyProfiles(
      [await sign(ana, "Ana", 1), await sign(ana, "Ana B", 2), await sign(mallory, "Not Ana", 3)],
      [ana.entry]
    );
    expect(names.get(ana.entry.keyHash)?.name).toBe("Ana B");
  });
});

describe("identity file v5", () => {
  it("round-trips keys, name and contact settings", async () => {
    const m = await newMember();
    const data = {
      publicKeyBase64: m.entry.ecdh,
      privateKeyJwk: await exportPrivateKey(m.ecdh.privateKey),
      signingPublicKeyBase64: m.entry.sig,
      signingPrivateKeyJwk: await exportPrivateKey(m.signing.privateKey),
      myName: "Ana ✨",
      contactSettings: [{ keyHash: "bb", nickname: "Bobby", volume: 40 }, { keyHash: "cc", volume: 100 }],
    };
    const parsed = parseIdentityBinary(writeIdentityBinary(data).buffer as ArrayBuffer);
    expect(parsed).toEqual({ ...data, contactSettings: [data.contactSettings[0], { keyHash: "cc", nickname: undefined, volume: 100 }] });
  });

  it("refuses old fixed-20 identity files", () => {
    expect(() => parseIdentityBinary(new Uint8Array([4, 0, 0]).buffer)).toThrow(/no longer supported/);
  });
});
