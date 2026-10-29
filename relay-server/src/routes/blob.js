import express, { Router } from "express";
import { blobSizeOf, MAX_BLOB_SIZE } from "../lib/directory.js";

export const MAX_BLOBS_PER_POST = 64;
/** Blobs per GET page. */
export const PAGE_BLOBS = 64;

/**
 * Blob API, protocol v2 (DESIGN.md §5): the server stores fixed-size encrypted blobs with no sender and no
 * recipient, numbered by seq. Every member downloads every blob once, from their own cursor, and keeps what
 * decrypts. Every request spends one anonymous token (requireToken), so the server knows a member is asking but not
 * which one. Blob size comes from the admin-signed directory (blobSize), so every blob on a server looks alike.
 */
export function blobRouter(prisma, computeExpiresAt, io, requireToken) {
  const router = Router();

  const currentBlobSize = async () => {
    const latest = await prisma.directory.findFirst({ orderBy: { version: "desc" }, select: { body: true } });
    return blobSizeOf(latest?.body);
  };

  // Store 1-64 blobs in one request (one token): body = n × blobSize bytes, stored in that order.
  router.post(
    "/",
    requireToken,
    express.raw({ type: "application/octet-stream", limit: MAX_BLOBS_PER_POST * MAX_BLOB_SIZE }),
    async (req, res) => {
      try {
        const size = await currentBlobSize();
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
        const n = buffer.length / size;
        if (!Number.isInteger(n) || n < 1 || n > MAX_BLOBS_PER_POST) {
          return res.status(400).json({ error: `Body must be 1-${MAX_BLOBS_PER_POST} blobs of exactly ${size} bytes`, blobSize: size });
        }
        const expiresAt = computeExpiresAt();
        // One INSERT keeps them in order: the sender puts the head blob first (DESIGN.md §5).
        await prisma.blob.createMany({
          data: Array.from({ length: n }, (_, i) => ({ payload: buffer.subarray(i * size, (i + 1) * size), expiresAt })),
        });
        if (io) io.emit("blobs");
        return res.status(201).json({ count: n, expiresAt: expiresAt.toISOString() });
      } catch (e) {
        console.error("blob store failed:", e?.message);
        return res.status(500).json({ error: "Failed to store blob" });
      }
    }
  );

  /**
   * Blobs after a cursor, oldest first. Binary: u32 count, u8 more; then per blob u64 seq, u64 expiresAt (ms),
   * u32 length, payload. (Base64 JSON would add a third to everyone's download.)
   */
  router.get("/", requireToken, async (req, res) => {
    try {
      const raw = typeof req.query.since === "string" ? req.query.since : "0";
      if (!/^\d{1,19}$/.test(raw)) return res.status(400).json({ error: "since must be a blob seq" });
      const rows = await prisma.blob.findMany({
        where: { seq: { gt: BigInt(raw) }, expiresAt: { gt: new Date() } },
        orderBy: { seq: "asc" },
        take: PAGE_BLOBS + 1,
        select: { seq: true, payload: true, expiresAt: true },
      });
      const page = rows.slice(0, PAGE_BLOBS);
      const head = Buffer.alloc(5);
      head.writeUInt32BE(page.length, 0);
      head.writeUInt8(rows.length > PAGE_BLOBS ? 1 : 0, 4);
      const parts = [head];
      for (const b of page) {
        const h = Buffer.alloc(20);
        h.writeBigUInt64BE(b.seq, 0);
        h.writeBigUInt64BE(BigInt(b.expiresAt.getTime()), 8);
        h.writeUInt32BE(b.payload.length, 16);
        parts.push(h, Buffer.from(b.payload));
      }
      res.set("Cache-Control", "no-store");
      res.type("application/octet-stream");
      return res.send(Buffer.concat(parts));
    } catch (e) {
      console.error("blob fetch failed:", e?.message);
      return res.status(500).json({ error: "Failed to fetch blobs" });
    }
  });

  // No DELETE route: blobs are removed only by the expiry worker.

  return router;
}
