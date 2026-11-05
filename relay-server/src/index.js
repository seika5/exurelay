import "./env.js";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { computeExpiresAt } from "./lib/expiry.js";
import { blobRouter } from "./routes/blob.js";
import { turnRouter } from "./routes/turn.js";
import { directoryRouter } from "./routes/directory.js";
import { authRouter } from "./routes/auth.js";
import { tokensRouter } from "./routes/tokens.js";
import { adminRouter } from "./routes/admin.js";
import { pushRouter } from "./routes/push.js";
import { registerSocketHandlers, disconnectKeyHashes } from "./socket.js";
import { createAuth } from "./lib/auth.js";
import { createIssuer, requireToken } from "./lib/tokens.js";

const prisma = new PrismaClient();
const app = express();
app.disable("x-powered-by");
const httpServer = createServer(app);

// Any origin may call the API: the official app, forks and local builds all live on different origins.
// That's safe because nothing uses cookies; every request carries its own session or token.
const corsOptions = { origin: true, credentials: false, exposedHeaders: [] };
app.use(cors(corsOptions));
// No global JSON body parser: routes that take JSON add their own small limit.
// No request logging, on purpose: requests must not be tied to IPs or times (DESIGN.md §1, §6).

// Pings every 10s, dropped after 10 more: a socket left behind by a network change is noticed within ~20s (the
// default is up to 45s), and the client notices a dead connection just as fast and reconnects.
const io = new Server(httpServer, { cors: corsOptions, pingInterval: 10_000, pingTimeout: 10_000 });

const auth = createAuth();
const issuer = createIssuer(prisma);
const spend = requireToken(issuer);

async function onMembersRemoved(keyHashes, version) {
  await issuer.rotateForRemoval(version);
  auth.revokeKeyHashes(keyHashes);
  disconnectKeyHashes(io, keyHashes);
  await dropPushSubscriptions(keyHashes);
}

/** A removed member, or an unlinked device, gets no more pushes. */
async function dropPushSubscriptions(keyHashes) {
  await prisma.pushSubscription.deleteMany({ where: { OR: [{ device: { in: keyHashes } }, { member: { in: keyHashes } }] } });
}

async function onMemberLeft(keyHashes) {
  auth.revokeKeyHashes(keyHashes);
  disconnectKeyHashes(io, keyHashes);
  await dropPushSubscriptions(keyHashes);
}

app.get("/health", (_, res) => res.status(200).json({ ok: true }));
app.use("/api/auth", authRouter(prisma, auth));
app.use("/api/tokens", tokensRouter(issuer, auth));
app.use("/api/blobs", blobRouter(prisma, computeExpiresAt, io, spend));
app.use("/api/turn", turnRouter(spend));
app.use("/api/directory", directoryRouter(prisma, io, { auth, onRemoved: onMembersRemoved, onLeft: onMemberLeft }));
app.use("/api/admin", adminRouter(prisma, auth, issuer));
app.use("/api/push", pushRouter(prisma, auth, spend));

registerSocketHandlers(io, prisma, auth);

// Create each day's issuer key shortly after UTC midnight even if nobody asks for tokens.
const ensureKey = () => issuer.ensureDailyKey().catch((e) => console.error("issuer key:", e?.message));
ensureKey();
setInterval(ensureKey, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 4000;
// Behind a TLS reverse proxy, set HOST=127.0.0.1 so the plain-HTTP port isn't reachable from outside.
const HOST = process.env.HOST || "0.0.0.0";
httpServer.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
});
