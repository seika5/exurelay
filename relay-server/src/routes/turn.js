import { Router } from "express";
import { getIceServersFromEnv } from "../lib/turn.js";

/**
 * TURN: hand allowed members short-lived TURN credentials instead of a static password baked into clients.
 * Gated on an allowed key hash for now; phase 3 replaces this with a blind-token spend.
 */
export function turnRouter(prisma) {
  const router = Router();

  router.get("/credentials", async (req, res) => {
    const keyHash = req.query.keyHash;
    if (!keyHash || typeof keyHash !== "string") {
      return res.status(400).json({ error: "keyHash required" });
    }
    const allowed = await prisma.member.findUnique({ where: { keyHash }, select: { keyHash: true } });
    if (!allowed) {
      return res.status(403).json({ error: "key not allowed" });
    }
    res.set("Cache-Control", "no-store");
    return res.json(getIceServersFromEnv());
  });

  return router;
}
