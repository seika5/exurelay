import express, { Router } from "express";
import { trustedAdmins, validateDirectory, validateLeave, validateProfile } from "../lib/directory.js";

const jsonBody = express.json({ limit: "512kb" });

/**
 * Member directory: the admin-signed list of members, plus each member's self-signed display name.
 * The server checks signatures so it only stores valid records, but clients verify everything again
 * against the admin keys they pinned when joining: the server alone can't add or swap a member.
 *
 * onRemoved(keyHashes, version) runs after a directory drops members: it rotates the token issuer key
 * and ends their sessions and sockets. onLeft(keyHash) runs when a member leaves on their own: it ends their
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
      res.set("Cache-Control", "no-store");
      return res.json({
        directory: latest ? { body: latest.body, signature: latest.signature } : null,
        profiles,
        departures,
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
      const result = await validateDirectory(req.body, trustedAdmins(latest?.body, envAdmins), latest?.version ?? 0);
      if (!result.ok) return res.status(400).json({ error: result.error });
      const d = result.directory;
      const departed = new Set((await prisma.departure.findMany({ select: { keyHash: true } })).map((x) => x.keyHash));
      const keep = d.members.map((m) => m.keyHash).filter((k) => !departed.has(k));
      const dropped = (await prisma.member.findMany({ where: { keyHash: { notIn: keep } }, select: { keyHash: true } })).map(
        (m) => m.keyHash
      );
      await prisma.$transaction([
        prisma.directory.create({ data: { version: d.version, body: req.body.body, signature: req.body.signature } }),
        prisma.member.deleteMany({ where: { keyHash: { notIn: keep } } }),
        prisma.profile.deleteMany({ where: { keyHash: { notIn: keep } } }),
        prisma.adminLabel.deleteMany({ where: { keyHash: { notIn: keep } } }),
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
      if (dropped.length > 0 && onRemoved) await onRemoved(dropped, d.version);
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
      const member = await prisma.member.findUnique({ where: { keyHash } });
      const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" }, select: { body: true } });
      const result = await validateLeave(req.body, member, trustedAdmins(latest?.body, envAdmins), { publicUrl });
      if (!result.ok) return res.status(400).json({ error: result.error });
      const data = { body: req.body.body, signature: req.body.signature };
      await prisma.$transaction([
        prisma.departure.upsert({ where: { keyHash }, create: { keyHash, ...data }, update: data }),
        prisma.member.delete({ where: { keyHash } }),
        prisma.profile.deleteMany({ where: { keyHash } }),
        prisma.adminLabel.deleteMany({ where: { keyHash } }),
      ]);
      if (onLeft) await onLeft(keyHash);
      if (io) io.emit("directory");
      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to leave" });
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
      const member = await prisma.member.findUnique({ where: { keyHash } });
      const previous = await prisma.profile.findUnique({ where: { keyHash }, select: { updatedAt: true } });
      const result = await validateProfile(req.body, member, previous ? Number(previous.updatedAt) : 0);
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
