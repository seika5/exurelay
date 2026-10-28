import { Router } from "express";
import { getIceServersFromEnv } from "../lib/turn.js";

/**
 * TURN: hand members short-lived TURN credentials instead of a static password baked into clients.
 * Paid for with one anonymous token, so the server can't tell which member is about to make a call.
 */
export function turnRouter(requireToken) {
  const router = Router();

  router.get("/credentials", requireToken, (_req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json(getIceServersFromEnv());
  });

  return router;
}
