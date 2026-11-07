/**
 * Unit tests for Socket.io handlers: voice (signal, join_room, etc.). Blob pings go to every socket (no rooms).
 * Run: cd server && node --test src/__tests__/socket.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { registerCallHandlers, registerSocketHandlers } from "../socket.js";

/** A "/call" namespace with real room bookkeeping, and sockets that record what they're sent. */
function callNamespace() {
  const rooms = new Map();
  const sockets = new Map();
  let onConnection;
  const nsp = { on: (_, cb) => { onConnection = cb; }, sockets, adapter: { rooms } };
  const spent = new Set();
  const valid = new Set(["t1", "t2", "t3", "t4"]);
  const spend = async (t) => {
    if (!valid.has(t) || spent.has(t)) return false;
    spent.add(t);
    return true;
  };
  registerCallHandlers(nsp, spend, { joinWithinMs: 60_000 });
  const connect = (id) => {
    const handlers = {};
    const got = [];
    const s = {
      id,
      connected: true,
      rooms: new Set([id]),
      on: (event, h) => { handlers[event] = h; },
      emit: (event, payload) => got.push({ event, payload }),
      join: (r) => {
        s.rooms.add(r);
        if (!rooms.has(r)) rooms.set(r, new Set());
        rooms.get(r).add(id);
      },
      leave: (r) => {
        s.rooms.delete(r);
        rooms.get(r)?.delete(id);
        if (rooms.get(r)?.size === 0) rooms.delete(r);
      },
      to: (r) => ({
        emit: (event, payload) => {
          for (const other of rooms.get(r) ?? []) if (other !== id) sockets.get(other).emit(event, payload);
        },
      }),
      disconnect: () => {
        handlers.disconnecting?.();
        for (const r of [...s.rooms]) s.leave(r);
        sockets.delete(id);
        s.connected = false;
      },
    };
    sockets.set(id, s);
    onConnection(s);
    // Emit with an acknowledgement, as socket.io-client's emit(..., cb) does.
    const ask = (event, ...args) => new Promise((resolve) => handlers[event](...args, resolve));
    const send = (event, payload) => handlers[event](payload);
    return { s, got, ask, send, handlers };
  };
  return { connect, rooms };
}

describe("registerSocketHandlers (voice)", () => {
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
    // Protocol v2: blobs have no recipient, so there are no per-member blob rooms to join.
    assert.ok(!events.includes("join_blob"), "blob rooms are gone");
    assert.ok(events.includes("join_room"), "should register join_room (voice group)");
    assert.ok(events.includes("leave_room"), "should register leave_room");
    assert.ok(events.includes("signal"), "should register signal (voice 1:1)");
    // Raw join/leave would let any socket enter any room (call or blob) without checks.
    assert.ok(!events.includes("join"), "must not register unchecked join");
    assert.ok(!events.includes("leave"), "must not register unchecked leave");
  });

  it("signal forwards only the sealed envelope, with the sender's socket, member and device, when they share a room", () => {
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
      data: { keyHash: "sender-device", member: "sender-member" },
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
    // Unsealed signals (plain SDP) are never forwarded.
    signalHandler({ to: "receiver-id", type: "offer", sdp: {} });
    assert.strictEqual(emitted.length, 0);
    signalHandler({ to: "receiver-id", sealed: "c2VhbGVk", type: "offer" });
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].target, "receiver-id");
    assert.strictEqual(emitted[0].event, "signal");
    assert.deepStrictEqual(emitted[0].payload, { from: "sender-id", fromKeyHash: "sender-member", fromDevice: "sender-device", sealed: "c2VhbGVk" });
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
    signalHandler({ to: "receiver-id", sealed: "c2VhbGVk" });
    assert.strictEqual(emitted.length, 0, "signal should be dropped when no shared room");
  });

  it("a dropped socket tells each of its call rooms it left", () => {
    let connectionCb;
    const io = {
      on: (_, cb) => { connectionCb = cb; },
      sockets: { adapter: { rooms: { get: () => new Set(["phone-id", "laptop-id"]) } }, sockets: new Map() },
    };
    registerSocketHandlers(io, null);
    const told = [];
    let disconnecting;
    connectionCb({
      id: "phone-id",
      rooms: new Set(["phone-id", "call-room-1"]),
      emit: () => {},
      to: (room) => ({ emit: (event, payload) => told.push({ room, event, payload }) }),
      on: (event, handler) => {
        if (event === "disconnecting") disconnecting = handler;
      },
    });
    disconnecting();
    assert.deepStrictEqual(told, [{ room: "call-room-1", event: "peer_left", payload: "phone-id" }]);
  });
});

describe("registerCallHandlers (anonymous calls)", () => {
  const ROOM = "room-AAAAAAAAAAAAAAAAAAAAAA";
  const OTHER_ROOM = "room-BBBBBBBBBBBBBBBBBBBBBB";

  it("has no logged-in join and no identity checks", () => {
    const { connect } = callNamespace();
    const { handlers } = connect("a");
    assert.ok(handlers.join && handlers.intro && handlers.signal && handlers.leave);
    assert.ok(!handlers.join_room, "legacy join stays on the logged-in namespace");
    assert.ok(!handlers.call_state, "mute state goes sealed, inside signals");
  });

  it("joins with a valid token; members and joins name socket ids only", async () => {
    const { connect } = callNamespace();
    const a = connect("a");
    const b = connect("b");
    assert.deepStrictEqual(await a.ask("join", ROOM, "t1"), { ok: true, members: [] });
    assert.deepStrictEqual(await b.ask("join", ROOM, "t2"), { ok: true, members: ["a"] });
    assert.deepStrictEqual(a.got, [{ event: "peer_joined", payload: "b" }]);
  });

  it("refuses a join without a token, with a spent token, or for a malformed room", async () => {
    const { connect, rooms } = callNamespace();
    const a = connect("a");
    const b = connect("b");
    assert.deepStrictEqual(await a.ask("join", ROOM, undefined), { ok: false, error: "token" });
    assert.deepStrictEqual(await a.ask("join", ROOM, "forged"), { ok: false, error: "token" });
    assert.deepStrictEqual(await a.ask("join", ROOM, "t1"), { ok: true, members: [] });
    assert.deepStrictEqual(await b.ask("join", ROOM, "t1"), { ok: false, error: "token" });
    assert.deepStrictEqual(await b.ask("join", "not-a-room", "t2"), { ok: false, error: "room" });
    assert.deepStrictEqual([...rooms.get(ROOM)], ["a"]);
    assert.deepStrictEqual(a.got, [], "nobody joined");
  });

  it("drops a socket after repeated bad tokens", async () => {
    const { connect } = callNamespace();
    const a = connect("a");
    for (let i = 0; i < 5; i++) await a.ask("join", ROOM, "forged");
    assert.strictEqual(a.s.connected, false);
  });

  it("relays intros and signals only between sockets in the same room, as from and sealed only", async () => {
    const { connect } = callNamespace();
    const a = connect("a");
    const b = connect("b");
    const c = connect("c");
    const d = connect("d"); // never joins
    await a.ask("join", ROOM, "t1");
    await b.ask("join", ROOM, "t2");
    await c.ask("join", OTHER_ROOM, "t3");
    a.got.length = 0;

    a.send("intro", { to: "b", sealed: "aW50cm8=", member: "spoofed" });
    a.send("signal", { to: "b", sealed: "c2lnbmFs" });
    a.send("signal", { to: "c", sealed: "c2lnbmFs" });
    a.send("signal", { to: "b", type: "offer" });
    d.send("signal", { to: "a", sealed: "c2lnbmFs" });
    c.send("intro", { to: "a", sealed: "aW50cm8=" });

    assert.deepStrictEqual(b.got, [
      { event: "intro", payload: { from: "a", sealed: "aW50cm8=" } },
      { event: "signal", payload: { from: "a", sealed: "c2lnbmFs" } },
    ]);
    assert.deepStrictEqual(c.got, []);
    assert.deepStrictEqual(a.got, []);
  });

  it("leaving tells the others and says who was last; a dropped socket leaves too", async () => {
    const { connect } = callNamespace();
    const a = connect("a");
    const b = connect("b");
    await a.ask("join", ROOM, "t1");
    await b.ask("join", ROOM, "t2");
    assert.deepStrictEqual(await b.ask("leave", ROOM), { last: false });
    assert.deepStrictEqual(a.got.at(-1), { event: "peer_left", payload: "b" });
    // After leaving, b can't reach a.
    b.send("signal", { to: "a", sealed: "c2lnbmFs" });
    assert.strictEqual(a.got.at(-1).event, "peer_left");
    assert.deepStrictEqual(await a.ask("leave", ROOM), { last: true });

    const c = connect("c");
    const e = connect("e");
    await c.ask("join", ROOM, "t3");
    await e.ask("join", ROOM, "t4");
    e.s.disconnect();
    assert.deepStrictEqual(c.got.at(-1), { event: "peer_left", payload: "e" });
  });
});
