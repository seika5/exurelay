import express, { Router } from "express";
import webpush from "web-push";
import { requireSession } from "./auth.js";
import { createPushLimiter } from "../lib/pushLimits.js";
import { isPermanentPushError } from "../lib/pushErrors.js";

const jsonBody = express.json({ limit: "64kb" });
const KINDS = new Set(["mention", "everyone", "ring"]);
const MAX_ITEMS = 64;
const MAX_PAYLOAD = 2048;

/**
 * Web Push, only for @mentions and call rings (DESIGN.md §9 "direct push (A)").
 *
 * - A logged-in device registers its push subscription (the server learns member → endpoint).
 * - A sender, paying with an anonymous token, asks for pushes to specific devices of the people it mentions or
 *   rings. Each payload is already encrypted device-to-device by the sender (relay-web/src/lib/push.ts); the server
 *   wraps it in Web Push encryption and forwards it. Limits are per recipient, whoever sends.
 * - Nothing about who was notified, by whom or when is stored or logged.
 *
 * Disabled (503) unless VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set (`npm run vapid` makes a pair).
 */
export function pushRouter(prisma, auth, requireToken, { publicUrl = process.env.PUBLIC_URL || "", env = process.env } = {}) {
  const router = Router();
  const configured = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  if (configured) webpush.setVapidDetails(env.VAPID_SUBJECT || "mailto:admin@localhost", env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const limiter = createPushLimiter();
  setInterval(() => limiter.sweep(), 5 * 60_000).unref?.();

  const off = (res) => res.status(503).json({ error: "This server doesn't send notifications (no VAPID keys)." });

  router.get("/vapid", (_req, res) => (configured ? res.json({ publicKey: env.VAPID_PUBLIC_KEY }) : off(res)));

  /**
   * Which devices have notifications on (members only). Senders address pushes only to these, so a mention of
   * someone who can't be notified never reaches the server. The server knows this list anyway (it holds the
   * subscriptions); this only tells members.
   */
  router.get("/devices", requireSession(auth), async (_req, res) => {
    if (!configured) return off(res);
    const rows = await prisma.pushSubscription.findMany({ select: { device: true }, distinct: ["device"] });
    res.set("Cache-Control", "no-store");
    return res.json({ devices: rows.map((r) => r.device) });
  });

  router.post("/subscribe", requireSession(auth), jsonBody, async (req, res) => {
    if (!configured) return off(res);
    const { endpoint, keys } = req.body ?? {};
    if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || endpoint.length > 2048) {
      return res.status(400).json({ error: "bad endpoint" });
    }
    if (typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string" || keys.p256dh.length > 200 || keys.auth.length > 100) {
      return res.status(400).json({ error: "bad keys" });
    }
    const data = { device: req.session.keyHash, member: req.session.member ?? req.session.keyHash, p256dh: keys.p256dh, auth: keys.auth };
    await prisma.pushSubscription.upsert({ where: { endpoint }, create: { endpoint, ...data }, update: data });
    return res.status(201).json({ ok: true });
  });

  router.post("/unsubscribe", requireSession(auth), jsonBody, async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint === "string") await prisma.pushSubscription.deleteMany({ where: { endpoint, device: req.session.keyHash } });
    return res.json({ ok: true });
  });

  router.post("/notify", requireToken, jsonBody, async (req, res) => {
    if (!configured) return off(res);
    const { kind, items } = req.body ?? {};
    if (!KINDS.has(kind) || !Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      return res.status(400).json({ error: "bad notify request" });
    }
    let sent = 0;
    let limited = 0;
    // One allowance per recipient member per request, however many of their devices are listed.
    const allowed = new Map();
    for (const item of items) {
      if (typeof item?.device !== "string" || typeof item?.payload !== "string" || item.payload.length > MAX_PAYLOAD) continue;
      const subs = await prisma.pushSubscription.findMany({ where: { device: item.device } });
      for (const sub of subs) {
        if (!allowed.has(sub.member)) allowed.set(sub.member, limiter.take(kind, sub.member));
        if (!allowed.get(sub.member)) {
          limited++;
          continue;
        }
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({ kind, server: publicUrl, payload: item.payload }),
            { TTL: kind === "ring" ? 60 : 3600, urgency: "high" }
          );
          sent++;
        } catch (e) {
          // It will never work (gone, or refused): drop it, so the member's switch shows off (lib/pushErrors.js).
          if (isPermanentPushError(e?.statusCode)) await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
        }
      }
    }
    return res.json({ sent, limited });
  });

  return router;
}
