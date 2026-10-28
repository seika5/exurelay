import express, { Router } from "express";
import { adminKeysFromEnv, validateDirectory, validateProfile } from "../lib/directory.js";

const jsonBody = express.json({ limit: "512kb" });

/**
 * Member directory: the admin-signed list of members, plus each member's self-signed display name.
 * The server checks signatures so it only stores valid records, but clients verify everything again
 * against the admin keys built into the app: the server alone can't add or swap a member.
 */
export function directoryRouter(prisma, io, adminKeys = adminKeysFromEnv()) {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" } });
      const profiles = await prisma.profile.findMany({ select: { body: true, signature: true } });
      res.set("Cache-Control", "no-store");
      return res.json({
        directory: latest ? { body: latest.body, signature: latest.signature } : null,
        profiles,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to load directory" });
    }
  });

  // Publishing needs no session: the admin signature on the directory is the authorization.
  router.post("/", jsonBody, async (req, res) => {
    try {
      const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
      const result = await validateDirectory(req.body, adminKeys, latest?.version ?? 0);
      if (!result.ok) return res.status(400).json({ error: result.error });
      const d = result.directory;
      const keep = d.members.map((m) => m.keyHash);
      await prisma.$transaction([
        prisma.directory.create({ data: { version: d.version, body: req.body.body, signature: req.body.signature } }),
        prisma.member.deleteMany({ where: { keyHash: { notIn: keep } } }),
        prisma.profile.deleteMany({ where: { keyHash: { notIn: keep } } }),
        ...d.members.map((m) =>
          prisma.member.upsert({
            where: { keyHash: m.keyHash },
            create: { keyHash: m.keyHash, ecdhPublicKey: m.ecdh, signingPublicKey: m.sig, enrolledAt: new Date(m.enrolledAt) },
            update: { ecdhPublicKey: m.ecdh, signingPublicKey: m.sig, enrolledAt: new Date(m.enrolledAt) },
          })
        ),
      ]);
      if (io) io.emit("directory");
      return res.status(201).json({ version: d.version });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to publish directory" });
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
