/**
 * Socket.io, two namespaces:
 * - "/" (logged in): "blobs" and "directory" pings. Blobs carry no recipient, so the ping goes to every socket (every
 *   logged-in member) after each upload, and each client syncs from its cursor. Each socket must present a login
 *   session (handshake auth.session), which fixes its keyHash. It still carries legacy calls (join_room), where the
 *   server sees who calls whom, for older apps only.
 * - "/call" (anonymous, registerCallHandlers): calls. No login; the server never learns who is in a call.
 */
const roomAllowedKeyHashes = new Map(); // roomId -> Set(keyHash), legacy calls only
/** An SDP with many candidates, base64 and encrypted, fits well inside this. */
const MAX_SEALED_SIGNAL = 64 * 1024;
/** Same format as relay-web/src/lib/callRoom.ts newRoomId. */
const ROOM_ID = /^room-[A-Za-z0-9_-]{16,64}$/;
const MAX_ROOM_SIZE = 50;
/** An anonymous socket that hasn't joined a call by then is dropped, so idle connections can't pile up for free. */
const JOIN_WITHIN_MS = 30_000;
const MAX_FAILED_JOINS = 5;

function emitRoomJoinError(socket, message = "Not allowed to join this call.") {
  socket.emit("room_join_error", { message });
}

export function registerSocketHandlers(io, prisma, auth) {
  if (auth && io.use) {
    io.use((socket, next) => {
      const session = auth.getSession(socket.handshake?.auth?.session);
      if (!session) return next(new Error("unauthorized"));
      socket.data = socket.data || {};
      // keyHash: this device; member: whose device it is (the same for a member's enrolled key).
      socket.data.keyHash = session.keyHash;
      socket.data.member = session.member ?? session.keyHash;
      next();
    });
  }

  io.on("connection", (socket) => {
    // Signals are sealed end to end (relay-web/src/lib/callSignal.ts): the server only routes the opaque envelope
    // and says which logged-in member sent it, so the receiver knows whose key should open it.
    socket.on("signal", (payload) => {
      const to = payload?.to;
      const sealed = payload?.sealed;
      if (!to || typeof sealed !== "string" || sealed.length > MAX_SEALED_SIGNAL) return;
      const targetSocket = io.sockets.sockets.get(to);
      if (!targetSocket) return;
      // Only relay if sender and target share a call room
      const senderRooms = socket.rooms; // Set<string>
      const shared = [...targetSocket.rooms].some(
        (r) => r !== to && r !== socket.id && senderRooms.has(r)
      );
      if (!shared) return;
      io.to(to).emit("signal", {
        from: socket.id,
        fromKeyHash: socket.data?.member ?? null,
        fromDevice: socket.data?.keyHash ?? null,
        sealed,
      });
    });

    // LEGACY, remove once apps older than the "/call" namespace are gone: a call joined as the logged-in member.
    // The member comes from the login session (a linked device joins as its member); the client's claim must match.
    socket.on("join_room", async (roomId, keyHash, allowedKeyHashes) => {
      try {
        if (!roomId) return;
        const member = socket.data?.member ?? keyHash ?? null;
        if (!Array.isArray(allowedKeyHashes) || allowedKeyHashes.length === 0) {
          emitRoomJoinError(socket);
          return;
        }
        const normalized = allowedKeyHashes.filter((k) => typeof k === "string" && k.trim()).slice(0, 100);
        if (!member || (keyHash && keyHash !== member) || !normalized.includes(member)) {
          emitRoomJoinError(socket);
          return;
        }
        if (!(await prisma.member.findUnique({ where: { keyHash: member } }))) {
          emitRoomJoinError(socket);
          return;
        }
        let set = roomAllowedKeyHashes.get(roomId);
        if (!set) {
          set = new Set(normalized);
          roomAllowedKeyHashes.set(roomId, set);
        }
        if (!set.has(member)) {
          emitRoomJoinError(socket);
          return;
        }
        socket.data = socket.data || {};
        socket.data.member = member;
        socket.data.keyHash = socket.data.keyHash ?? member;
        socket.join(roomId);
        const room = io.sockets.adapter.rooms.get(roomId);
        const others = room ? Array.from(room).filter((id) => id !== socket.id) : [];
        // keyHash: the member (for names and tiles); device: the device's own key (for sealing signals to it).
        const describe = (s, id) => ({ id, keyHash: s?.data?.member ?? null, device: s?.data?.keyHash ?? null });
        socket.emit("members", others.map((id) => describe(io.sockets.sockets.get(id), id)));
        socket.to(roomId).emit("peer_joined", describe(socket, socket.id));
      } catch (e) {
        console.error("join_room error:", e?.message);
      }
    });

    socket.on("leave_room", (roomId) => {
      if (roomId) {
        socket.leave(roomId);
        const room = io.sockets.adapter.rooms.get(roomId);
        if (!room || room.size === 0) {
          roomAllowedKeyHashes.delete(roomId);
          socket.emit("last_to_leave");
        }
        socket.to(roomId).emit("peer_left", socket.id);
      }
    });

    // A dropped socket (a phone changing networks, a closed tab) leaves its rooms without saying so: tell the others,
    // so they close its connection. A reconnect joins again under a new socket id.
    socket.on("disconnecting", () => {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue;
        socket.to(roomId).emit("peer_left", socket.id);
        if ((io.sockets.adapter.rooms.get(roomId)?.size ?? 0) <= 1) roomAllowedKeyHashes.delete(roomId);
      }
    });

    socket.on("call_state", (roomId, state) => {
      if (roomId && state && typeof state.muted === "boolean" && typeof state.deafened === "boolean") {
        socket.to(roomId).emit("peer_call_state", { id: socket.id, muted: state.muted, deafened: state.deafened });
      }
    });

  });
}

/**
 * Anonymous calls (DESIGN.md §7) on the "/call" namespace. Sockets here don't log in. Joining a room costs one
 * anonymous token, so strangers can't flood rooms; knowing the random room id, which is only ever sent inside
 * encrypted messages, is the capability. The server keeps room -> socket ids and relays opaque envelopes between
 * sockets in the same room: "intro" (sealed with the room secret: which member and device is behind a socket) and
 * "signal" (sealed device to device). Joins and member lists name socket ids only.
 *
 * Removed members can't be kicked from a call here, since the server doesn't know who they are. Each new call has a
 * fresh secret sent only to current members, and peers refuse intros from anyone no longer in the conversation.
 */
export function registerCallHandlers(nsp, spend, { joinWithinMs = JOIN_WITHIN_MS } = {}) {
  nsp.on("connection", (socket) => {
    let room = null;
    let failed = 0;
    const idle = setTimeout(() => {
      if (!room) socket.disconnect(true);
    }, joinWithinMs);
    idle.unref?.();
    const reply = (cb, value) => {
      if (typeof cb === "function") cb(value);
    };
    const size = (r) => nsp.adapter.rooms.get(r)?.size ?? 0;
    const leave = () => {
      const r = room;
      room = null;
      socket.leave(r);
      socket.to(r).emit("peer_left", socket.id);
      return size(r) === 0;
    };

    socket.on("join", async (roomId, token, cb) => {
      if (typeof roomId !== "string" || !ROOM_ID.test(roomId)) return reply(cb, { ok: false, error: "room" });
      // Checked before spending, so a full room doesn't cost a token.
      if (size(roomId) >= MAX_ROOM_SIZE) return reply(cb, { ok: false, error: "full" });
      let ok = false;
      try {
        ok = await spend(token);
      } catch {
        return reply(cb, { ok: false, error: "server" });
      }
      if (!ok) {
        if (++failed >= MAX_FAILED_JOINS) socket.disconnect(true);
        return reply(cb, { ok: false, error: "token" });
      }
      if (socket.connected === false) return;
      clearTimeout(idle);
      if (room) leave();
      room = roomId;
      socket.join(roomId);
      const others = [...(nsp.adapter.rooms.get(roomId) ?? [])].filter((id) => id !== socket.id);
      socket.to(roomId).emit("peer_joined", socket.id);
      reply(cb, { ok: true, members: others });
    });

    const relay = (event) => (payload) => {
      const to = payload?.to;
      const sealed = payload?.sealed;
      if (!room || typeof to !== "string" || to === socket.id) return;
      if (typeof sealed !== "string" || sealed.length > MAX_SEALED_SIGNAL) return;
      const target = nsp.sockets.get(to);
      if (target?.rooms?.has(room)) target.emit(event, { from: socket.id, sealed });
    };
    socket.on("intro", relay("intro"));
    socket.on("signal", relay("signal"));

    socket.on("leave", (roomId, cb) => {
      if (!room || roomId !== room) return reply(cb, { last: false });
      reply(cb, { last: leave() });
    });

    socket.on("disconnecting", () => {
      clearTimeout(idle);
      if (room) socket.to(room).emit("peer_left", socket.id);
    });
  });
}

/** Disconnect every socket logged in as one of these (removed) members. */
export function disconnectKeyHashes(io, keyHashes) {
  const gone = new Set(keyHashes);
  for (const s of io.sockets.sockets.values()) {
    if (gone.has(s.data?.keyHash) || gone.has(s.data?.member)) s.disconnect(true);
  }
}
