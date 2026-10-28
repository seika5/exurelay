import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { computeExpiresAt } from "./lib/expiry.js";
import { blobRouter } from "./routes/blob.js";
import { keysRouter } from "./routes/keys.js";
import { turnRouter } from "./routes/turn.js";
import { registerSocketHandlers } from "./socket.js";

const prisma = new PrismaClient();
const app = express();
const httpServer = createServer(app);

// Allow WEB_ORIGIN, any localhost (for dev: 3000, 3001, etc.), and Capacitor iOS origin.
const corsOrigin = (origin, cb) => {
  if (!origin) return cb(null, true);
  if (process.env.WEB_ORIGIN && origin === process.env.WEB_ORIGIN) return cb(null, origin);
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, origin);
  // Capacitor iOS app runs at capacitor://localhost
  if (origin === "capacitor://localhost") return cb(null, origin);
  return cb(null, false);
};
app.use(cors({ origin: corsOrigin, credentials: true }));
// No JSON body parser: no route accepts JSON, and the old 50mb limit was a memory-DoS vector.

const io = new Server(httpServer, {
  cors: { origin: corsOrigin, credentials: true },
});

app.get("/health", (_, res) => res.status(200).json({ ok: true }));
app.use("/api/blobs", blobRouter(prisma, computeExpiresAt, io));
app.use("/api/keys", keysRouter(prisma));
app.use("/api/turn", turnRouter(prisma));

registerSocketHandlers(io, prisma);

const PORT = process.env.PORT || 4000;
// Behind a TLS reverse proxy, set HOST=127.0.0.1 so the plain-HTTP port isn't reachable from outside.
const HOST = process.env.HOST || "0.0.0.0";
httpServer.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
});
