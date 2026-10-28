import express, { Router } from "express";
import { bearer } from "../lib/auth.js";
import { trustedAdmins } from "../lib/directory.js";

const jsonBody = express.json({ limit: "16kb" });

/** Is this session's signing key one of the admins trusted for the next directory? */
export async function sessionIsAdmin(prisma, session) {
  const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" }, select: { body: true } });
  return trustedAdmins(latest?.body).includes(session.signingPublicKey);
}

/** Express middleware: needs `Authorization: Bearer <session>` from POST /api/auth/login. */
export function requireSession(auth) {
  return (req, res, next) => {
    const session = auth.getSession(bearer(req));
    if (!session) return res.status(401).json({ error: "log in first", code: "session" });
    req.session = session;
    next();
  };
}

export function authRouter(prisma, auth) {
  const router = Router();

  router.post("/challenge", (_req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      return res.json({ nonce: auth.challenge() });
    } catch {
      return res.status(503).json({ error: "try again later" });
    }
  });

  router.post("/login", jsonBody, async (req, res) => {
    try {
      let keyHash;
      try {
        keyHash = JSON.parse(req.body?.body ?? "").keyHash;
      } catch {
        return res.status(400).json({ error: "malformed login" });
      }
      const member =
        typeof keyHash === "string"
          ? await prisma.member.findUnique({ where: { keyHash }, select: { keyHash: true, signingPublicKey: true } })
          : null;
      const result = await auth.login(req.body, member);
      if (!result.ok) return res.status(401).json({ error: result.error });
      const isAdmin = await sessionIsAdmin(prisma, member);
      return res.json({ session: result.session, expiresAt: result.expiresAt, isAdmin });
    } catch {
      return res.status(500).json({ error: "login failed" });
    }
  });

  return router;
}
