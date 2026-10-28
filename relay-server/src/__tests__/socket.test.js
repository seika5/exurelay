/**
 * Unit tests for Socket.io handlers: blob rooms (refresh) and voice (signal, join_room, etc.).
 * Run: cd server && node --test src/__tests__/socket.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { registerSocketHandlers } from "../socket.js";

describe("registerSocketHandlers (voice + blob)", () => {
  it("registers connection and expected event handlers on socket", () => {
    let connectionCb;
    const io = {
      on: (event, cb) => {
        assert.strictEqual(event, "connection");
        connectionCb = cb;
      },
    };
    registerSocketHandlers(io, null);
    assert.strictEqual(typeof connectionCb, "function");

    const onCalls = [];
    const socket = {
      id: "test-id",
      join: () => {},
      leave: () => {},
      emit: () => {},
      to: () => ({ emit: () => {} }),
      on: (event, handler) => {
        onCalls.push({ event, handler: typeof handler });
      },
    };
    connectionCb(socket);

    const events = onCalls.map((c) => c.event).sort();
    assert.ok(events.includes("join_blob"), "should register join_blob (blob refresh)");
    assert.ok(events.includes("leave_blob"), "should register leave_blob");
    assert.ok(events.includes("join_room"), "should register join_room (voice group)");
    assert.ok(events.includes("leave_room"), "should register leave_room");
    assert.ok(events.includes("signal"), "should register signal (voice 1:1)");
    // Raw join/leave would let any socket enter any room (call or blob) without checks.
    assert.ok(!events.includes("join"), "must not register unchecked join");
    assert.ok(!events.includes("leave"), "must not register unchecked leave");
  });

  it("join_blob adds socket to blob:keyHash room", async () => {
    const rooms = new Map();
    let connectionCb;
    const io = {
      on: (_, cb) => { connectionCb = cb; },
      sockets: {
        adapter: { rooms: { get: (id) => rooms.get(id) ?? null } },
        sockets: new Map(),
      },
      to: () => ({ emit: () => {} }),
    };
    const prisma = {
      allowedKey: { findUnique: async () => ({ id: "1", keyHash: "abcKeyHash123" }) },
    };
    registerSocketHandlers(io, prisma);

    const joined = [];
    let joinBlobHandler;
    const socket = {
      id: "s1",
      rooms: new Set(["s1"]),
      join: (room) => joined.push(room),
      leave: () => {},
      emit: () => {},
      to: () => ({ emit: () => {} }),
      on: (event, handler) => {
        if (event === "join_blob") joinBlobHandler = handler;
      },
    };
    connectionCb(socket);
    await joinBlobHandler("abcKeyHash123");
    assert.strictEqual(joined[0], "blob:abcKeyHash123");
  });

  it("signal forwards payload to target with from when they share a room", () => {
    const emitted = [];
    let connectionCb;
    // Both sender and receiver are in "call-room-1"
    const receiverSocket = {
      id: "receiver-id",
      rooms: new Set(["receiver-id", "call-room-1"]),
    };
    const socketsMap = new Map([["receiver-id", receiverSocket]]);
    const io = {
      on: (_, cb) => { connectionCb = cb; },
      sockets: {
        adapter: { rooms: { get: () => null } },
        sockets: socketsMap,
      },
      to: (target) => ({
        emit: (event, payload) => emitted.push({ target, event, payload }),
      }),
    };
    registerSocketHandlers(io, null);

    let signalHandler;
    const socket = {
      id: "sender-id",
      rooms: new Set(["sender-id", "call-room-1"]),
      join: () => {},
      leave: () => {},
      emit: () => {},
      to: () => ({ emit: () => {} }),
      on: (event, handler) => {
        if (event === "signal") signalHandler = handler;
      },
    };
    connectionCb(socket);
    signalHandler({ to: "receiver-id", type: "offer", sdp: {} });
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].target, "receiver-id");
    assert.strictEqual(emitted[0].event, "signal");
    assert.strictEqual(emitted[0].payload.from, "sender-id");
    assert.strictEqual(emitted[0].payload.type, "offer");
  });

  it("signal is dropped when sender and target share no room", () => {
    const emitted = [];
    let connectionCb;
    const receiverSocket = {
      id: "receiver-id",
      rooms: new Set(["receiver-id", "other-room"]),
    };
    const socketsMap = new Map([["receiver-id", receiverSocket]]);
    const io = {
      on: (_, cb) => { connectionCb = cb; },
      sockets: {
        adapter: { rooms: { get: () => null } },
        sockets: socketsMap,
      },
      to: (target) => ({
        emit: (event, payload) => emitted.push({ target, event, payload }),
      }),
    };
    registerSocketHandlers(io, null);

    let signalHandler;
    const socket = {
      id: "sender-id",
      rooms: new Set(["sender-id", "call-room-1"]),
      join: () => {},
      leave: () => {},
      emit: () => {},
      to: () => ({ emit: () => {} }),
      on: (event, handler) => {
        if (event === "signal") signalHandler = handler;
      },
    };
    connectionCb(socket);
    signalHandler({ to: "receiver-id", type: "offer", sdp: {} });
    assert.strictEqual(emitted.length, 0, "signal should be dropped when no shared room");
  });
});
