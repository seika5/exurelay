/**
 * Enrollment codes, admin-signed directories, member profiles and departures.
 */

import { describe, it, expect } from "vitest";
import { exportPublicKey, generateKeyPair, generateSigningKeyPair } from "../crypto";
import {
  createEnrollmentCode,
  directoryWithMember,
  directoryWithoutMember,
  directoryWithoutMembers,
  keyHashOf,
  readEnrollmentCode,
  signRecord,
  verifyDepartures,
  verifyDevices,
  directoryWithAdmins,
  deviceCert,
  deviceRevoke,
  verifyDirectory,
  verifyProfiles,
  ENROLLMENT_CODE_TTL_MS,
  type DirectoryMember,
} from "../signed";

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
  it("accepts the prefix in any capitalization", async () => {
    const ecdh = await generateKeyPair();
    const sig = await generateSigningKeyPair();
    const code = await createEnrollmentCode(ecdh.publicKey, sig, "Laptop", 1000);
    const lowered = "relay-enroll:" + code.slice("RELAY-ENROLL:".length);
    expect((await readEnrollmentCode(lowered, 1000)).ok).toBe(true);
  });

  it("says so when it's given the server's join code instead", async () => {
    const join = await readEnrollmentCode("RELAY-JOIN:eyJ0eXBlIjoicmVsYXktam9pbiJ9");
    expect(join.ok === false && join.error).toMatch(/join code/);
    const link = await readEnrollmentCode("https://exurelay.com/#join=RELAY-JOIN:abc");
    expect(link.ok === false && link.error).toMatch(/join code/);
    const other = await readEnrollmentCode("hello");
    expect(other.ok === false && other.error).toMatch(/RELAY-ENROLL:/);
  });

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

describe("departures", () => {
  it("counts only leaves signed by the member themself, and the admin can drop them all at once", async () => {
    const admin = await newMember();
    const a = await newMember();
    const b = await newMember();
    const members = [admin.entry, a.entry, b.entry];
    const leave = (keyHash: string) => ({ type: "relay-leave", keyHash, server: "https://relay.example", ts: 1 });
    const own = await signRecord(a.signing.privateKey, leave(a.entry.keyHash));
    const forged = await signRecord(a.signing.privateKey, leave(b.entry.keyHash));
    const gone = await verifyDepartures([own, forged], members);
    expect([...gone]).toEqual([a.entry.keyHash]);

    const d = { type: "relay-directory" as const, version: 3, issuedAt: 1, signer: admin.entry.sig, members, removed: [], admins: [admin.entry.sig, a.entry.sig] };
    const next = directoryWithoutMembers(d, admin.entry.sig, [...gone], 5);
    expect(next.version).toBe(4);
    expect(next.members.map((m) => m.keyHash)).toEqual([admin.entry.keyHash, b.entry.keyHash]);
    expect(next.removed).toEqual([{ keyHash: a.entry.keyHash, removedAt: 5 }]);
    expect(next.admins).toEqual([admin.entry.sig]);
  });
});

describe("linked devices", () => {
  it("accepts certificate chains from the member's devices, ignores forgeries, and applies unlinks", async () => {
    const [ana, laptop, phone, mallory] = await Promise.all([newMember(), newMember(), newMember(), newMember()]);
    const req = (m: typeof ana) => ({ type: "relay-enroll" as const, ecdh: m.entry.ecdh, sig: m.entry.sig, name: "x", ts: 1 });
    // Ana's enrolled device certifies the laptop; the laptop certifies the phone.
    const laptopCert = await signRecord(ana.signing.privateKey, deviceCert(ana.entry.keyHash, req(laptop), "Laptop", ana.entry.sig, 2));
    const phoneCert = await signRecord(laptop.signing.privateKey, deviceCert(ana.entry.keyHash, req(phone), "Phone", laptop.entry.sig, 3));
    // Mallory (not Ana's device) tries to add her key to Ana's account, claiming Ana signed it.
    const forged = await signRecord(mallory.signing.privateKey, deviceCert(ana.entry.keyHash, req(mallory), "Evil", ana.entry.sig, 4));

    const devices = await verifyDevices([phoneCert, forged, laptopCert], [], [ana.entry]);
    expect(devices.get(ana.entry.keyHash)!.map((d) => d.name || "enrolled")).toEqual(["enrolled", "Laptop", "Phone"]);

    // The phone unlinks the laptop; a revocation signed by a stranger is ignored.
    const unlink = await signRecord(phone.signing.privateKey, deviceRevoke(ana.entry.keyHash, laptop.entry.keyHash, phone.entry.sig, 5));
    const bogus = await signRecord(mallory.signing.privateKey, deviceRevoke(ana.entry.keyHash, phone.entry.keyHash, mallory.entry.sig, 5));
    const revoked = new Set<string>();
    const after = await verifyDevices([laptopCert, phoneCert], [unlink, bogus], [ana.entry], revoked);
    expect(after.get(ana.entry.keyHash)!.map((d) => d.name || "enrolled")).toEqual(["enrolled", "Phone"]);
    // The laptop can tell it was unlinked; the bogus unlink of the phone doesn't count.
    expect([...revoked]).toEqual([laptop.entry.keyHash]);
  });
});

describe("admin devices", () => {
  it("move admin to a linked device, and drop it when that member is removed", async () => {
    const [ana, laptop, bob] = await Promise.all([newMember(), newMember(), newMember()]);
    const devices = new Map([
      [ana.entry.keyHash, [
        { keyHash: ana.entry.keyHash, ecdh: ana.entry.ecdh, sig: ana.entry.sig, name: "", addedAt: 1, primary: true },
        { keyHash: laptop.entry.keyHash, ecdh: laptop.entry.ecdh, sig: laptop.entry.sig, name: "Laptop", addedAt: 2, primary: false },
      ]],
    ]);
    const d = { type: "relay-directory" as const, version: 3, issuedAt: 1, signer: ana.entry.sig, members: [ana.entry, bob.entry], removed: [], admins: [ana.entry.sig, bob.entry.sig] };

    const moved = directoryWithAdmins(d, ana.entry.sig, [laptop.entry.sig, bob.entry.sig], 5, devices);
    expect(moved.admins).toEqual([laptop.entry.sig, bob.entry.sig]);
    // Without knowing Ana's devices, the laptop's key isn't a member's and is dropped.
    expect(directoryWithAdmins(d, ana.entry.sig, [laptop.entry.sig, bob.entry.sig], 5).admins).toEqual([bob.entry.sig]);

    const withoutAna = directoryWithoutMembers({ ...moved, signer: bob.entry.sig }, bob.entry.sig, [ana.entry.keyHash], 6, devices);
    expect(withoutAna.admins).toEqual([bob.entry.sig]);
  });
});
