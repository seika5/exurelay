import { randomUUID } from "crypto";
import express, { Router } from "express";

const BLOB_SIZE = 65536;

/**
 * Blob API: store/retrieve encrypted blobs (binary, fixed size) by recipient key hash.
 * Zero-knowledge: no sender or sentAt; 72hr expiry computed server-side.
 */
export function blobRouter(prisma, computeExpiresAt, io) {
  const router = Router();

  // Store one blob: body = raw binary exactly BLOB_SIZE bytes; recipientKeyHash in query
  router.post(
    "/",
    express.raw({ type: "application/octet-stream", limit: BLOB_SIZE + 1024 }),
    async (req, res) => {
      try {
        const recipientKeyHash = req.query.recipientKeyHash;
        if (!recipientKeyHash || typeof recipientKeyHash !== "string") {
          return res.status(400).json({ error: "recipientKeyHash required (query param)" });
        }
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
        if (buffer.length !== BLOB_SIZE) {
          return res.status(400).json({ error: `Payload must be exactly ${BLOB_SIZE} bytes` });
        }
        const allowed = await prisma.member.findUnique({ where: { keyHash: recipientKeyHash } });
        if (!allowed) {
          return res.status(403).json({ error: "recipient key not allowed" });
        }
        const expiresAt = computeExpiresAt();
        const id = randomUUID();
        await prisma.blob.create({
          data: {
            id,
            recipientKeyHash,
            payload: buffer,
            expiresAt,
          },
        });
        if (io) io.to(`blob:${recipientKeyHash}`).emit("refresh");
        return res.status(201).json({ id, expiresAt: expiresAt.toISOString() });
      } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Failed to store blob" });
      }
    }
  );

  // Fetch blobs for a key hash. Only allowed keys can receive/fetch blobs.
  router.get("/", async (req, res) => {
    try {
      const recipientKeyHash = req.query.recipientKeyHash;
      if (!recipientKeyHash) {
        return res.status(400).json({ error: "recipientKeyHash required" });
      }
      const allowed = await prisma.member.findUnique({ where: { keyHash: recipientKeyHash } });
      if (!allowed) {
        return res.status(403).json({ error: "recipient key not allowed" });
      }
      const blobs = await prisma.blob.findMany({
        where: { recipientKeyHash },
        select: { id: true, payload: true, expiresAt: true },
        orderBy: { expiresAt: "asc" },
      });
      return res.json(
        blobs.map((b) => ({
          id: b.id,
          payload: b.payload.toString("base64"),
          expiresAt: b.expiresAt.toISOString(),
        }))
      );
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Failed to fetch blobs" });
    }
  });

  // No DELETE route: requests are unauthenticated, so anyone knowing a key hash could wipe
  // that user's inbox. Blobs are removed only by the expiry worker.

  return router;
}
