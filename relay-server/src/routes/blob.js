import { randomUUID } from "crypto";
import express, { Router } from "express";

const BLOB_SIZE = 65536;
export const MAX_BLOBS_PER_POST = 64;

/**
 * Blob API: store/retrieve encrypted blobs (binary, fixed size) by recipient key hash.
 * Zero-knowledge: no sender or sentAt; 72hr expiry computed server-side.
 * Every request spends one anonymous token (requireToken), so the server knows a member is asking
 * but not which one. Recipient hashes are still visible until protocol v2 (phase 5).
 */
export function blobRouter(prisma, computeExpiresAt, io, requireToken) {
  const router = Router();

  // Store one or more blobs in one request (one token): body = n × BLOB_SIZE bytes, `to` = n comma-separated
  // recipient key hashes in the same order.
  router.post(
    "/",
    requireToken,
    express.raw({ type: "application/octet-stream", limit: MAX_BLOBS_PER_POST * BLOB_SIZE + 1024 }),
    async (req, res) => {
      try {
        const to = typeof req.query.to === "string" ? req.query.to.split(",").filter(Boolean) : [];
        if (to.length === 0 || to.length > MAX_BLOBS_PER_POST) {
          return res.status(400).json({ error: `to must list 1-${MAX_BLOBS_PER_POST} recipient key hashes` });
        }
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
        if (buffer.length !== to.length * BLOB_SIZE) {
          return res.status(400).json({ error: `Payload must be exactly ${BLOB_SIZE} bytes per recipient` });
        }
        const recipients = [...new Set(to)];
        const found = await prisma.member.count({ where: { keyHash: { in: recipients } } });
        if (found !== recipients.length) {
          return res.status(403).json({ error: "recipient key not allowed" });
        }
        const expiresAt = computeExpiresAt();
        const rows = to.map((recipientKeyHash, i) => ({
          id: randomUUID(),
          recipientKeyHash,
          payload: buffer.subarray(i * BLOB_SIZE, (i + 1) * BLOB_SIZE),
          expiresAt,
        }));
        await prisma.blob.createMany({ data: rows });
        if (io) for (const r of recipients) io.to(`blob:${r}`).emit("refresh");
        return res.status(201).json({ ids: rows.map((r) => r.id), expiresAt: expiresAt.toISOString() });
      } catch (e) {
        console.error("blob store failed:", e?.message);
        return res.status(500).json({ error: "Failed to store blob" });
      }
    }
  );

  // Fetch blobs for a key hash.
  router.get("/", requireToken, async (req, res) => {
    try {
      const recipientKeyHash = req.query.recipientKeyHash;
      if (!recipientKeyHash || typeof recipientKeyHash !== "string") {
        return res.status(400).json({ error: "recipientKeyHash required" });
      }
      const allowed = await prisma.member.findUnique({ where: { keyHash: recipientKeyHash }, select: { keyHash: true } });
      if (!allowed) {
        return res.status(403).json({ error: "recipient key not allowed" });
      }
      const blobs = await prisma.blob.findMany({
        where: { recipientKeyHash },
        select: { id: true, payload: true, expiresAt: true },
        orderBy: { expiresAt: "asc" },
      });
      res.set("Cache-Control", "no-store");
      return res.json(
        blobs.map((b) => ({
          id: b.id,
          payload: b.payload.toString("base64"),
          expiresAt: b.expiresAt.toISOString(),
        }))
      );
    } catch (e) {
      console.error("blob fetch failed:", e?.message);
      return res.status(500).json({ error: "Failed to fetch blobs" });
    }
  });

  // No DELETE route: blobs are removed only by the expiry worker.

  return router;
}
