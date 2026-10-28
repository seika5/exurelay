import express, { Router } from "express";
import { requireSession } from "./auth.js";

const jsonBody = express.json({ limit: "64kb" });

/**
 * Anonymous tokens. GET /keys is public so clients can check the issuer key schedule.
 * POST / is the identified refill: a logged-in member sends blinded messages and gets blind signatures.
 */
export function tokensRouter(issuer, auth) {
  const router = Router();

  router.get("/keys", async (_req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      return res.json({ keys: await issuer.publicKeys() });
    } catch {
      return res.status(500).json({ error: "Failed to load issuer keys" });
    }
  });

  router.post("/", requireSession(auth), jsonBody, async (req, res) => {
    try {
      const result = await issuer.issue(req.session.keyHash, req.body?.keyId, req.body?.blinded);
      if (!result.ok) {
        if (result.retryAfter) res.set("Retry-After", String(result.retryAfter));
        return res.status(result.status).json({ error: result.error, remaining: result.remaining, retryAfter: result.retryAfter });
      }
      res.set("Cache-Control", "no-store");
      return res.json({ keyId: result.keyId, signatures: result.signatures, remaining: result.remaining });
    } catch {
      return res.status(500).json({ error: "Failed to issue tokens" });
    }
  });

  return router;
}
