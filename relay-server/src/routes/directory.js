import express, { Router } from "express";
import { setupCodeMatches, trustedAdmins, validateDirectory, validateLeave } from "../lib/directory.js";
import { profilesTag, validateProfileCopies } from "../lib/profiles.js";
import { requireSession } from "./auth.js";
import { parseBody } from "../lib/signed.js";
import { memberSigners, validateDeviceCert, validateDeviceRevoke } from "../lib/devices.js";

const jsonBody = express.json({ limit: "512kb" });

/**
 * Member directory: the admin-signed list of members and their devices, plus each member's sealed profile copies
 * (display name, and device names for their own devices), encrypted to each recipient device (lib/profiles.js).
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
export function directoryRouter(
  prisma,
  io,
  { auth, envAdmins, onRemoved, onLeft, publicUrl = process.env.PUBLIC_URL || "", setupCode = process.env.SETUP_CODE || "" } = {}
) {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" } });
      const departures = await prisma.departure.findMany({ select: { body: true, signature: true } });
      const devices = await prisma.device.findMany({ select: { body: true, signature: true } });
      const deviceRevocations = await prisma.deviceRevocation.findMany({ select: { body: true, signature: true } });
      res.set("Cache-Control", "no-store");
      return res.json({
        directory: latest ? { body: latest.body, signature: latest.signature } : null,
        departures,
        devices,
        deviceRevocations,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to load directory" });
    }
  });

  // Publishing needs no session: the admin signature on the directory is the authorization. The very first one may
  // instead come with the server's one-time setup code (X-Relay-Setup), which makes its signer the first admin.
  router.post("/", jsonBody, async (req, res) => {
    try {
      const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" }, select: { version: true, body: true } });
      const devices = await prisma.device.findMany({ select: { member: true, signingPublicKey: true } });
      const deviceSigsOf = (member) => devices.filter((x) => x.member === member).map((x) => x.signingPublicKey);
      let admins = trustedAdmins(latest?.body, envAdmins);
      const offered = req.get("x-relay-setup");
      if (!latest && offered) {
        if (!setupCodeMatches(setupCode, offered)) return res.status(403).json({ error: "That setup code isn't right." });
        const signer = parseBody(req.body)?.signer;
        if (typeof signer === "string") admins = [...admins, signer];
      }
      const result = await validateDirectory(req.body, admins, latest?.version ?? 0, deviceSigsOf);
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
        // Profile copies by or for anyone dropped (and their devices) go too.
        prisma.profileCopy.deleteMany({
          where: { OR: [{ author: { notIn: keep } }, { recipient: { in: [...dropped, ...droppedDevices] } }] },
        }),
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
        prisma.profileCopy.deleteMany({ where: { OR: [{ author: keyHash }, { recipient: { in: [keyHash, ...devices.map((d) => d.keyHash)] } }] } }),
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
        prisma.profileCopy.deleteMany({ where: { recipient: keyHash } }),
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

  // Sealed profiles: only a logged-in device of a current member reads or writes them. A device gets only the copies
  // addressed to it; it writes copies as its own member, for other current devices.
  if (auth) {
    router.get("/profiles", requireSession(auth), async (req, res) => {
      try {
        res.set("Cache-Control", "no-store");
        const where = { recipient: req.session.keyHash };
        // ?tag= from the last answer: if nothing changed, say so instead of sending every copy again.
        if (typeof req.query.tag === "string") {
          const heads = await prisma.profileCopy.findMany({ where, select: { author: true, sender: true, nonce: true, updatedAt: true } });
          const tag = profilesTag(heads);
          if (tag === req.query.tag) return res.json({ unchanged: true, tag });
        }
        const copies = (
          await prisma.profileCopy.findMany({
            where,
            select: { author: true, sender: true, nonce: true, ciphertext: true, updatedAt: true },
          })
        ).map((c) => ({ ...c, updatedAt: Number(c.updatedAt) }));
        return res.json({ copies, tag: profilesTag(copies) });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Failed to load profiles" });
      }
    });

    router.post("/profiles", requireSession(auth), jsonBody, async (req, res) => {
      try {
        const [members, devices] = await Promise.all([
          prisma.member.findMany({ select: { keyHash: true } }),
          prisma.device.findMany({ select: { keyHash: true, member: true } }),
        ]);
        const memberSet = new Set(members.map((m) => m.keyHash));
        if (!memberSet.has(req.session.member)) return res.status(403).json({ error: "not a member" });
        const current = new Set([...memberSet, ...devices.filter((d) => memberSet.has(d.member)).map((d) => d.keyHash)]);
        const result = validateProfileCopies(req.body, req.session, (k) => current.has(k));
        if (!result.ok) return res.status(400).json({ error: result.error });
        // Newer copies replace older ones; an older one (a device that hadn't caught up) is ignored.
        const existing = new Map(
          (
            await prisma.profileCopy.findMany({
              where: { author: req.session.member, recipient: { in: result.rows.map((r) => r.recipient) } },
              select: { recipient: true, updatedAt: true },
            })
          ).map((c) => [c.recipient, Number(c.updatedAt)])
        );
        const rows = result.rows.filter((r) => !(existing.get(r.recipient) > r.updatedAt));
        await prisma.$transaction(
          rows.map((r) => {
            const data = { sender: r.sender, nonce: r.nonce, ciphertext: r.ciphertext, updatedAt: BigInt(r.updatedAt) };
            return prisma.profileCopy.upsert({
              where: { author_recipient: { author: r.author, recipient: r.recipient } },
              create: { author: r.author, recipient: r.recipient, ...data },
              update: data,
            });
          })
        );
        if (io && rows.length) io.emit("directory");
        return res.status(201).json({ stored: rows.length });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Failed to save profiles" });
      }
    });
  }

  return router;
}
