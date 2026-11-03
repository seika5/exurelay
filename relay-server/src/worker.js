/**
 * Background worker: delete blobs where expiresAt < NOW(), and spent-token records and issuer keys
 * once their key has expired (a token can't be replayed against an expired key).
 * Run via: npm run worker (or cron)
 */
import "./env.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const INTERVAL_MS = 60 * 1000;
const VACUUM_EVERY_MS = 60 * 60 * 1000;
let lastVacuum = 0;

async function run() {
  const result = await prisma.blob.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (result.count > 0) {
    console.log(`Deleted ${result.count} expired blob(s)`);
  }
  await prisma.spentToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  // Keep expired issuer keys a week so the admin status page can show recent rotations.
  await prisma.issuerKey.deleteMany({ where: { notAfter: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } });
  // A deleted row stays in the table file until its space is reused. VACUUM marks that space free so new blobs
  // overwrite it sooner; it can't promise the bytes are gone from disk, which is why blobs are encrypted.
  if (Date.now() - lastVacuum >= VACUUM_EVERY_MS) {
    lastVacuum = Date.now();
    await prisma.$executeRawUnsafe('VACUUM "Blob"');
  }
}

async function loop() {
  try {
    await run();
  } catch (e) {
    console.error("Worker error:", e);
  }
  setTimeout(loop, INTERVAL_MS);
}

loop();
