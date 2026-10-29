import express, { Router } from "express";
import { trustedAdmins, validateDirectory, validateLeave, validateProfile } from "../lib/directory.js";
import { memberSigners, validateDeviceCert, validateDeviceRevoke } from "../lib/devices.js";

const jsonBody = express.json({ limit: "512kb" });

/**
 * Member directory: the admin-signed list of members, plus each member's self-signed display name.
 * The server checks signatures so it only stores valid records, but clients verify everything again
 * against the admin keys they pinned when joining: the server alone can't add or swap a member.
 *
 * onRemoved(keyHashes, version) runs after a directory drops members: it rotates the token issuer key
 * and ends their sessions and sockets. onLeft(keyHashes) runs when a member leaves on their own, or a device is unlinked: it ends those
 * sessions and sockets (no key rotation: they deleted their own tokens).
 *
 * A member who leaves is deleted at once (their pending messages can't be: blobs carry no recipient, DESIGN.md §5) and their signed leave is kept as a Departure until an admin's
 * directory drops them. Until then, clients verify the departure and treat them as gone, and the server
 * never re-adds them from an older-looking directory that still lists them.
 */
export function directoryRouter(prisma, io, { envAdmins, onRemoved, onLeft, publicUrl = process.env.PUBLIC_URL || "" } = {}) {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" } });
      const profiles = await prisma.profile.findMany({ select: { body: true, signature: true } });
      const departures = await prisma.departure.findMany({ select: { body: true, signature: true } });
      const devices = await prisma.device.findMany({ select: { body: true, signature: true } });
      const deviceRevocations = await prisma.deviceRevocation.findMany({ select: { body: true, signature: true } });
      res.set("Cache-Control", "no-store");
      return res.json({
        directory: latest ? { body: latest.body, signature: latest.signature } : null,
        profiles,
        departures,
        devices,
        deviceRevocations,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to load directory" });
    }
  });

  // Publishing needs no session: the admin signature on the directory is the authorization.
  router.post("/", jsonBody, async (req, res) => {
    try {
      const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" }, select: { version: true, body: true } });
      const devices = await prisma.device.findMany({ select: { member: true, signingPublicKey: true } });
      const deviceSigsOf = (member) => devices.filter((x) => x.member === member).map((x) => x.signingPublicKey);
      const result = await validateDirectory(req.body, trustedAdmins(latest?.body, envAdmins), latest?.version ?? 0, deviceSigsOf);
      if (!result.ok) return res.status(400).json({ error: result.error });
      const d = result.directory;
      const departed = new Set((await prisma.departure.findMany({ select: { keyHash: true } })).map((x) => x.keyHash));
      const keep = d.members.map((m) => m.keyHash).filter((k) => !departed.has(k));
      const dropped = (await prisma.member.findMany({ where: { keyHash: { notIn: keep } }, select: { keyHash: true } })).map(
        (m) => m.keyHash
      );
      // Their linked devices go with them.
      const droppedDevices = (await prisma.device.findMany({ where: { member: { in: dropped } }, select: { keyHash: true } })).map(
        (d) => d.keyHash
      );
      await prisma.$transaction([
        prisma.directory.create({ data: { version: d.version, body: req.body.body, signature: req.body.signature } }),
        prisma.member.deleteMany({ where: { keyHash: { notIn: keep } } }),
        prisma.profile.deleteMany({ where: { keyHash: { notIn: keep } } }),
        prisma.adminLabel.deleteMany({ where: { keyHash: { notIn: keep } } }),
        prisma.device.deleteMany({ where: { member: { notIn: keep } } }),
        prisma.deviceRevocation.deleteMany({ where: { member: { notIn: keep } } }),
        // Departures the admin has now dropped are done; the rest stay until they're dropped too.
        prisma.departure.deleteMany({ where: { keyHash: { notIn: d.members.map((m) => m.keyHash) } } }),
        ...d.members.filter((m) => !departed.has(m.keyHash)).map((m) =>
          prisma.member.upsert({
            where: { keyHash: m.keyHash },
            create: { keyHash: m.keyHash, ecdhPublicKey: m.ecdh, signingPublicKey: m.sig, enrolledAt: new Date(m.enrolledAt) },
            update: { ecdhPublicKey: m.ecdh, signingPublicKey: m.sig, enrolledAt: new Date(m.enrolledAt) },
          })
        ),
      ]);
      if (dropped.length > 0 && onRemoved) await onRemoved([...dropped, ...droppedDevices], d.version);
      if (io) io.emit("directory");
      return res.status(201).json({ version: d.version });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to publish directory" });
    }
  });

  // Leaving needs no session either: the member's own signature is the authorization.
  router.post("/leave", jsonBody, async (req, res) => {
    try {
      let keyHash;
      try {
        keyHash = JSON.parse(req.body?.body ?? "").keyHash;
      } catch {
        return res.status(400).json({ error: "malformed leave request" });
      }
      if (typeof keyHash !== "string") return res.status(400).json({ error: "malformed leave request" });
      const { member, signers, devices } = await memberSigners(prisma, keyHash);
      const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" }, select: { body: true } });
      const result = await validateLeave(req.body, member, trustedAdmins(latest?.body, envAdmins), { publicUrl, signers });
      if (!result.ok) return res.status(400).json({ error: result.error });
      const data = { body: req.body.body, signature: req.body.signature };
      await prisma.$transaction([
        prisma.departure.upsert({ where: { keyHash }, create: { keyHash, ...data }, update: data }),
        prisma.member.delete({ where: { keyHash } }),
        prisma.profile.deleteMany({ where: { keyHash } }),
        prisma.adminLabel.deleteMany({ where: { keyHash } }),
        prisma.device.deleteMany({ where: { member: keyHash } }),
        prisma.deviceRevocation.deleteMany({ where: { member: keyHash } }),
      ]);
      if (onLeft) await onLeft([keyHash, ...devices.map((d) => d.keyHash)]);
      if (io) io.emit("directory");
      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to leave" });
    }
  });

  /** Certify a linked device for a member (signed by one of their devices; no admin needed). */
  router.post("/device", jsonBody, async (req, res) => {
    try {
      let memberKeyHash;
      try {
        memberKeyHash = JSON.parse(req.body?.body ?? "").member;
      } catch {
        return res.status(400).json({ error: "malformed device certificate" });
      }
      if (typeof memberKeyHash !== "string") return res.status(400).json({ error: "malformed device certificate" });
      const { member, signers } = await memberSigners(prisma, memberKeyHash);
      if (!member) return res.status(400).json({ error: "not a member" });
      const taken = async (keyHash, sig) =>
        !!(await prisma.member.findFirst({ where: { OR: [{ keyHash }, { signingPublicKey: sig }] } })) ||
        !!(await prisma.device.findFirst({ where: { OR: [{ keyHash }, { signingPublicKey: sig }] } })) ||
        !!(await prisma.deviceRevocation.findUnique({ where: { keyHash } }));
      const result = await validateDeviceCert(req.body, signers, taken);
      if (!result.ok) return res.status(400).json({ error: result.error });
      const d = result.device;
      await prisma.device.create({
        data: { keyHash: d.keyHash, member: memberKeyHash, ecdhPublicKey: d.ecdh, signingPublicKey: d.sig, body: req.body.body, signature: req.body.signature },
      });
      if (io) io.emit("directory");
      return res.status(201).json({ keyHash: d.keyHash });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to link device" });
    }
  });

  /** Unlink one of a member's devices (signed by any of their devices, including that one). */
  router.post("/device/revoke", jsonBody, async (req, res) => {
    try {
      let memberKeyHash;
      try {
        memberKeyHash = JSON.parse(req.body?.body ?? "").member;
      } catch {
        return res.status(400).json({ error: "malformed device unlink" });
      }
      if (typeof memberKeyHash !== "string") return res.status(400).json({ error: "malformed device unlink" });
      const { member, signers, devices } = await memberSigners(prisma, memberKeyHash);
      if (!member) return res.status(400).json({ error: "not a member" });
      const result = await validateDeviceRevoke(req.body, signers, devices);
      if (!result.ok) return res.status(400).json({ error: result.error });
      const keyHash = result.revoke.keyHash;
      // An admin device can't be unlinked while it holds admin: its key could still sign member lists.
      const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" }, select: { body: true } });
      const sig = devices.find((x) => x.keyHash === keyHash)?.signingPublicKey;
      if (sig && trustedAdmins(latest?.body, envAdmins).includes(sig)) {
        return res.status(400).json({ error: "That device is an admin device. Move admin to another device first." });
      }
      await prisma.$transaction([
        prisma.device.delete({ where: { keyHash } }),
        prisma.deviceRevocation.create({ data: { keyHash, member: memberKeyHash, body: req.body.body, signature: req.body.signature } }),
      ]);
      if (onLeft) await onLeft([keyHash]);
      if (io) io.emit("directory");
      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to unlink device" });
    }
  });

  router.post("/profile", jsonBody, async (req, res) => {
    try {
      let keyHash;
      try {
        keyHash = JSON.parse(req.body?.body ?? "").keyHash;
      } catch {
        return res.status(400).json({ error: "malformed profile" });
      }
      if (typeof keyHash !== "string") return res.status(400).json({ error: "malformed profile" });
      const { member, signers } = await memberSigners(prisma, keyHash);
      const previous = await prisma.profile.findUnique({ where: { keyHash }, select: { updatedAt: true } });
      const result = await validateProfile(req.body, member, previous ? Number(previous.updatedAt) : 0, signers);
      if (!result.ok) return res.status(400).json({ error: result.error });
      const data = { body: req.body.body, signature: req.body.signature, updatedAt: BigInt(result.profile.updatedAt) };
      await prisma.profile.upsert({ where: { keyHash }, create: { keyHash, ...data }, update: data });
      if (io) io.emit("directory");
      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to save profile" });
    }
  });

  return router;
}
