/**
 * Socket.io: signaling for WebRTC 1:1 and group (room-based).
 * No auth at transport; clients use key-derived identities in payloads.
 * Room authorization: only key hashes in the room's allowed set can join;
 * join_room and join_blob additionally validate keyHash against the AllowedKey DB table.
 */
const roomAllowedKeyHashes = new Map(); // roomId -> Set(keyHash)

function emitRoomJoinError(socket, message = "Not allowed to join this call.") {
  socket.emit("room_join_error", { message });
}

export function registerSocketHandlers(io, prisma) {
  io.on("connection", (socket) => {
    socket.on("signal", (payload) => {
      const { to, ...data } = payload;
      if (!to) return;
      const targetSocket = io.sockets.sockets.get(to);
      if (!targetSocket) return;
      // Only relay if sender and target share a call room
      const senderRooms = socket.rooms; // Set<string>
      const shared = [...targetSocket.rooms].some(
        (r) => r !== to && r !== socket.id && senderRooms.has(r)
      );
      if (!shared) return;
      io.to(to).emit("signal", { from: socket.id, ...data });
    });

    socket.on("join_room", async (roomId, keyHash, allowedKeyHashes) => {
      try {
        if (!roomId) return;
        keyHash = keyHash || null;
        if (!Array.isArray(allowedKeyHashes) || allowedKeyHashes.length === 0) {
          emitRoomJoinError(socket);
          return;
        }
        const normalized = allowedKeyHashes
          .filter((k) => typeof k === "string" && k.trim())
          .slice(0, 100);
        if (normalized.length === 0 || !keyHash || !normalized.includes(keyHash)) {
          emitRoomJoinError(socket);
          return;
        }
        // DB-validate that the joining keyHash is a registered allowed key
        const dbAllowed = await prisma.allowedKey.findUnique({ where: { keyHash } });
        if (!dbAllowed) {
          emitRoomJoinError(socket);
          return;
        }
        let set = roomAllowedKeyHashes.get(roomId);
        if (!set) {
          set = new Set(normalized);
          roomAllowedKeyHashes.set(roomId, set);
        }
        if (!set.has(keyHash)) {
          emitRoomJoinError(socket);
          return;
        }
        socket.data = socket.data || {};
        socket.data.keyHash = keyHash;
        socket.join(roomId);
        const room = io.sockets.adapter.rooms.get(roomId);
        const memberIds = room ? Array.from(room).filter((id) => id !== socket.id) : [];
        const members = memberIds.map((id) => {
          const s = io.sockets.sockets.get(id);
          return { id, keyHash: s?.data?.keyHash ?? null };
        });
        socket.emit("members", members);
        socket.to(roomId).emit("peer_joined", { id: socket.id, keyHash: socket.data.keyHash ?? null });
      } catch (e) {
        console.error("join_room error:", e);
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

    socket.on("call_state", (roomId, state) => {
      if (roomId && state && typeof state.muted === "boolean" && typeof state.deafened === "boolean") {
        socket.to(roomId).emit("peer_call_state", { id: socket.id, muted: state.muted, deafened: state.deafened });
      }
    });

    socket.on("join_blob", async (keyHash) => {
      try {
        if (!keyHash) return;
        const allowed = await prisma.allowedKey.findUnique({ where: { keyHash } });
        if (!allowed) return;
        socket.join(`blob:${keyHash}`);
      } catch (e) {
        console.error("join_blob error:", e);
      }
    });

    socket.on("leave_blob", (keyHash) => {
      if (keyHash) socket.leave(`blob:${keyHash}`);
    });
  });
}
