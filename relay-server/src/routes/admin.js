import { Router } from "express";
import { requireSession, sessionIsAdmin } from "./auth.js";
import { getIceServersFromEnv } from "../lib/turn.js";

/** Admin tab: server status. Needs a logged-in admin session. */
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

  return router;
}
