import express, { Router } from "express";
import { requireSession, sessionIsAdmin } from "./auth.js";
import { getIceServersFromEnv } from "../lib/turn.js";

const jsonBody = express.json({ limit: "16kb" });
const MAX_LABEL = 64;

/** Admin tab: server status and admin-only member labels. Needs a logged-in admin session. */
export function adminRouter(prisma, auth, issuer) {
  const router = Router();

  router.use(requireSession(auth), async (req, res, next) => {
    try {
      if (!(await sessionIsAdmin(prisma, req.session))) return res.status(403).json({ error: "admins only" });
      res.set("Cache-Control", "no-store");
      next();
    } catch {
      return res.status(500).json({ error: "admin check failed" });
    }
  });

  router.get("/status", async (_req, res) => {
    try {
      const [members, blobs, latest, keys] = await Promise.all([
        prisma.member.count(),
        prisma.blob.count(),
        prisma.directory.findFirst({ orderBy: { version: "desc" }, select: { version: true } }),
        issuer.publicKeys(),
      ]);
      const ice = getIceServersFromEnv();
      return res.json({
        members,
        blobs,
        blobBytes: blobs * 65536,
        directoryVersion: latest?.version ?? 0,
        tokens: issuer.stats(),
        issuerKeys: keys.map(({ publicKey: _pk, ...k }) => k),
        turn: { configured: ice.iceServers.some((s) => s.credential), servers: ice.iceServers.length },
      });
    } catch {
      return res.status(500).json({ error: "Failed to load status" });
    }
  });

  router.get("/labels", async (_req, res) => {
    try {
      const rows = await prisma.adminLabel.findMany();
      return res.json({ labels: Object.fromEntries(rows.map((r) => [r.keyHash, r.label])) });
    } catch {
      return res.status(500).json({ error: "Failed to load labels" });
    }
  });

  router.put("/labels/:keyHash", jsonBody, async (req, res) => {
    try {
      const { keyHash } = req.params;
      const label = typeof req.body?.label === "string" ? req.body.label.trim().slice(0, MAX_LABEL) : "";
      const member = await prisma.member.findUnique({ where: { keyHash }, select: { keyHash: true } });
      if (!member) return res.status(404).json({ error: "not a member" });
      if (!label) await prisma.adminLabel.deleteMany({ where: { keyHash } });
      else await prisma.adminLabel.upsert({ where: { keyHash }, create: { keyHash, label }, update: { label } });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: "Failed to save label" });
    }
  });

  return router;
}
