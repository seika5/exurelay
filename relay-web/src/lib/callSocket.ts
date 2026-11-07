/**
 * The socket calls use (DESIGN.md §7). Each call gets its own connection to the server's "/call" namespace, which
 * doesn't log in: joining costs one anonymous token, and the server only sees socket ids in a random room. Peers say
 * who they are to each other in intros sealed with the room secret (callIntro.ts); then offers, answers, ICE and
 * mute state go sealed device to device (callSignal.ts), as before.
 *
 * To the call code this looks like the old logged-in call socket: the same events ("members", "peer_joined" with
 * member and device, "peer_call_state", ...), only now they come from verified intros instead of the server.
 * Calls an older app started (no room secret) still go the legacy way, over the logged-in socket; remove that with the
 * server's join_room. Every other event goes to the logged-in socket.
 */

import { io, type Socket } from "socket.io-client";
import { introKey, openIntro, sealIntro } from "./callIntro";
import { openSignal, sealSignal, secureSignalSocket, signalKey, type SecureSignalOptions } from "./callSignal";
import { getServerUrl } from "./server";
import { withToken } from "./tokens";

export type CallSocketOptions = SecureSignalOptions & {
  /** This device's member, device and signing key, for our intros. */
  intro: () => { member: string; device: string; signingKey: CryptoKey } | null;
  /** A device's signing public key, only if it's a current device of a current member allowed in this call. */
  signerFor: (member: string, device: string) => string | undefined;
};

type PeerInfo = { id: string; keyHash: string; device: string };
type JoinReply = { ok: boolean; error?: string; members?: unknown };
type Call = { roomId: string; roomKey: string; key: Promise<CryptoKey>; inbox: Map<string, Promise<void>>; outbox: Map<string, Promise<void>> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io listener signature
type Handler = (...args: any[]) => void;
/** The part of a socket.io Socket the call code uses. */
type Facade = {
  on(event: string, h: Handler): Facade;
  once(event: string, h: Handler): Facade;
  off(event: string, h?: Handler): Facade;
  emit(event: string, ...args: unknown[]): Facade;
  close(): void;
  readonly id: string | undefined;
  readonly connected: boolean;
};

/** Events the call code hears from this socket rather than from the logged-in one. */
const CALL_EVENTS = new Set(["members", "peer_joined", "peer_left", "peer_call_state", "room_join_error", "last_to_leave", "signal", "connect"]);
/** How long a joiner waits for the intros of those already in the room before it starts offering. */
const INTRO_WAIT_MS = 3000;
const ACK_TIMEOUT_MS = 10_000;

/** Signals to and from one peer stay in order (an intro before the signals that rely on it). */
function queue(chains: Map<string, Promise<void>>, id: string, run: () => Promise<void>) {
  const next = (chains.get(id) ?? Promise.resolve()).then(run, run);
  chains.set(id, next.catch(() => {}));
}

export function callSocket(main: Socket, opts: CallSocketOptions): Socket {
  const listeners = new Map<string, Set<Handler>>();
  const onceWrapped = new Map<Handler, Handler>();
  const fire = (event: string, ...args: unknown[]) => [...(listeners.get(event) ?? [])].forEach((h) => h(...args));
  let mode: "idle" | "legacy" | "anon" = "idle";

  // LEGACY (calls started by older apps): the logged-in socket, where the server says who is behind each socket.
  const legacy = secureSignalSocket(main, opts);
  for (const event of ["members", "peer_joined", "peer_left", "peer_call_state", "room_join_error", "last_to_leave", "connect"]) {
    main.on(event, (...args: unknown[]) => {
      if (mode !== "anon") fire(event, ...args);
    });
  }
  legacy.on("signal", (p: unknown) => {
    if (mode !== "anon") fire("signal", p);
  });

  // Anonymous calls.
  let raw: Socket | null = null;
  let call: Call | null = null;
  /** Socket id -> who its intro says it is, once verified. Nobody else is a participant. */
  const peers = new Map<string, { member: string; device: string }>();
  let waiting: { ids: Set<string>; found: PeerInfo[]; timer: ReturnType<typeof setTimeout> } | null = null;
  let lastState: { muted: boolean; deafened: boolean } | null = null;

  const keyFor = async (c: Call, peer: { member: string; device: string }, from: string, to: string) => {
    const me = opts.me();
    const pub = opts.publicKeyFor(peer.device);
    if (!me || !pub || !opts.allowed()?.has(peer.member)) return null;
    return signalKey(me.keyPair.privateKey, pub, c.roomId, from, to);
  };

  const sendSealed = (to: string, data: Record<string, unknown>) => {
    const c = call;
    if (!c) return;
    queue(c.outbox, to, async () => {
      const me = opts.me();
      const peer = peers.get(to);
      const r = raw;
      if (call !== c || !me || !peer || !r) return;
      const key = await keyFor(c, peer, me.keyHash, peer.device);
      if (key) r.emit("signal", { to, sealed: await sealSignal(key, data) });
    });
  };

  const sendIntro = (c: Call, to: string) => {
    queue(c.outbox, to, async () => {
      const me = opts.intro();
      const r = raw;
      if (call !== c || !me || !r?.id) return;
      const sealed = await sealIntro(await c.key, me.signingKey, { roomId: c.roomId, socket: r.id, member: me.member, device: me.device });
      r.emit("intro", { to, sealed });
    });
  };

  // Those already in the room when we joined come as one "members" list (so we offer to them, as the call code
  // expects); anyone verified later comes as "peer_joined".
  const flush = () => {
    const w = waiting;
    if (!w) return;
    waiting = null;
    clearTimeout(w.timer);
    fire("members", w.found, false);
  };
  const settle = (id: string, found: PeerInfo | null) => {
    if (found && lastState) sendSealed(id, { callState: lastState });
    if (waiting?.ids.delete(id)) {
      if (found) waiting.found.push(found);
      if (waiting.ids.size === 0) flush();
    } else if (found) fire("peer_joined", found);
  };

  const connect = (): Socket => {
    // forceNew: its own connection, not multiplexed onto the logged-in one, so the server can't tie the two together
    // by connection (it may still by IP and timing).
    // The URL's path is the namespace, so only the origin goes before "/call" (the main socket's path is fixed too).
    const r = io(`${new URL(getServerUrl()).origin}/call`, { path: "/socket.io", transports: ["websocket", "polling"], forceNew: true });
    let connectedBefore = false;
    r.on("connect", () => {
      if (raw !== r) return;
      // Back under a new id (the network changed): the server dropped us from the room. The call code joins again.
      if (connectedBefore) {
        peers.clear();
        fire("connect");
      }
      connectedBefore = true;
    });
    r.on("peer_joined", (id: unknown) => {
      if (raw === r && call && typeof id === "string") sendIntro(call, id);
    });
    r.on("peer_left", (id: unknown) => {
      if (raw !== r || typeof id !== "string") return;
      peers.delete(id);
      if (waiting?.ids.delete(id) && waiting.ids.size === 0) flush();
      fire("peer_left", id);
    });
    r.on("intro", (p: { from?: unknown; sealed?: unknown }) => {
      const c = call;
      const from = p?.from;
      const sealed = p?.sealed;
      if (raw !== r || !c || typeof from !== "string" || typeof sealed !== "string") return;
      queue(c.inbox, from, async () => {
        if (call !== c || peers.has(from)) return;
        const who = await openIntro(await c.key, sealed, { roomId: c.roomId, from, signerFor: opts.signerFor });
        if (call !== c) return;
        if (who) peers.set(from, who);
        settle(from, who && { id: from, keyHash: who.member, device: who.device });
      });
    });
    r.on("signal", (p: { from?: unknown; sealed?: unknown }) => {
      const c = call;
      const from = p?.from;
      const sealed = p?.sealed;
      if (raw !== r || !c || typeof from !== "string" || typeof sealed !== "string") return;
      queue(c.inbox, from, async () => {
        const me = opts.me();
        const peer = peers.get(from);
        if (call !== c || !me || !peer) return;
        const key = await keyFor(c, peer, peer.device, me.keyHash);
        const data = key && (await openSignal<Record<string, unknown>>(key, sealed));
        if (!data || call !== c) return;
        const state = data.callState as { muted?: unknown; deafened?: unknown } | undefined;
        if (!state) fire("signal", { ...data, from });
        else if (typeof state.muted === "boolean" && typeof state.deafened === "boolean") {
          fire("peer_call_state", { id: from, muted: state.muted, deafened: state.deafened });
        }
      });
    });
    return r;
  };

  const endAnon = (): Socket | null => {
    const r = raw;
    raw = null;
    call = null;
    peers.clear();
    if (waiting) clearTimeout(waiting.timer);
    waiting = null;
    lastState = null;
    mode = "idle";
    return r;
  };

  const joinAnon = async (roomId: string, roomKey: string) => {
    if (!raw) raw = connect();
    const r = raw;
    const c: Call = { roomId, roomKey, key: introKey(roomKey, roomId), inbox: new Map(), outbox: new Map() };
    call = c;
    peers.clear();
    if (waiting) clearTimeout(waiting.timer);
    waiting = null;
    let reply: JoinReply | null;
    try {
      reply = await withToken<JoinReply>(
        (token) =>
          new Promise((resolve) => {
            r.timeout(ACK_TIMEOUT_MS).emit("join", roomId, token, (err: unknown, res: JoinReply) => {
              if (err) resolve({ ok: false, error: "timeout" });
              else resolve(res?.error === "token" ? null : res);
            });
          })
      );
    } catch {
      reply = { ok: false, error: "token" };
    }
    if (call !== c) return;
    if (!reply?.ok || !Array.isArray(reply.members)) {
      endAnon()?.close();
      const error = reply?.error;
      fire("room_join_error", {
        message:
          error === "full" ? "This call is full." : error === "timeout" ? "Couldn't reach the call server." : error === "token" ? "Couldn't pay to join the call. Try again." : "Couldn't join the call.",
      });
      return;
    }
    const others = reply.members.filter((id): id is string => typeof id === "string" && id !== r.id);
    others.forEach((id) => sendIntro(c, id));
    // Nobody else here: we started the call.
    if (others.length === 0) {
      fire("members", [], true);
      return;
    }
    const found = others.filter((id) => peers.has(id)).map((id) => ({ id, keyHash: peers.get(id)!.member, device: peers.get(id)!.device }));
    const ids = new Set(others.filter((id) => !peers.has(id)));
    waiting = { ids, found, timer: setTimeout(flush, INTRO_WAIT_MS) };
    if (ids.size === 0) flush();
  };

  const leaveAnon = (roomId: string) => {
    const r = endAnon();
    if (!r) return;
    r.timeout(2000).emit("leave", roomId, (err: unknown, res: { last?: boolean }) => {
      if (!err && res?.last) fire("last_to_leave");
      r.close();
    });
  };

  const facade: Facade = {
    on(event: string, h: Handler) {
      if (!CALL_EVENTS.has(event)) main.on(event, h);
      else listeners.set(event, (listeners.get(event) ?? new Set()).add(h));
      return facade;
    },
    once(event: string, h: Handler) {
      if (!CALL_EVENTS.has(event)) {
        main.once(event, h);
        return facade;
      }
      const w: Handler = (...args) => {
        facade.off(event, h);
        h(...args);
      };
      onceWrapped.set(h, w);
      return facade.on(event, w);
    },
    off(event: string, h?: Handler) {
      if (!CALL_EVENTS.has(event)) {
        if (h) main.off(event, h);
        else main.off(event);
      } else if (!h) listeners.delete(event);
      else {
        listeners.get(event)?.delete(h);
        const w = onceWrapped.get(h);
        if (w) listeners.get(event)?.delete(w);
        onceWrapped.delete(h);
      }
      return facade;
    },
    emit(event: string, ...args: unknown[]) {
      if (event === "join_room") {
        // A rejoin (after a reconnect) doesn't repeat the secret: it's the same call.
        const [roomId, keyHash, allowed, given] = args as [string, string | null, string[], string | undefined];
        const roomKey = given ?? (call?.roomId === roomId ? call.roomKey : undefined);
        if (roomKey) {
          mode = "anon";
          joinAnon(roomId, roomKey).catch(() => {});
        } else {
          mode = "legacy";
          legacy.emit("join_room", roomId, keyHash, allowed);
        }
      } else if (mode === "anon") {
        if (event === "leave_room") leaveAnon(args[0] as string);
        else if (event === "signal") {
          const { to, ...data } = args[0] as { to: string } & Record<string, unknown>;
          sendSealed(to, data);
        } else if (event === "call_state") {
          // Mute state goes sealed to each verified peer; the server doesn't see it.
          const s = args[1] as { muted?: unknown; deafened?: unknown };
          if (typeof s?.muted !== "boolean" || typeof s.deafened !== "boolean") return facade;
          lastState = { muted: s.muted, deafened: s.deafened };
          for (const id of peers.keys()) sendSealed(id, { callState: lastState });
        }
      } else {
        if (event === "leave_room") mode = "idle";
        legacy.emit(event, ...args);
      }
      return facade;
    },
    close() {
      endAnon()?.close();
      main.close();
    },
    get id() {
      return mode === "anon" ? raw?.id : main.id;
    },
    get connected() {
      return mode === "anon" ? !!raw?.connected : main.connected;
    },
  };
  return facade as unknown as Socket;
}
