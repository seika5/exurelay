/**
 * End-to-end sealed call signaling (DESIGN.md §7). Every offer, answer and ICE candidate is encrypted to the one
 * peer it's for, with a key from the static ECDH secret between the two members, bound to the room and the
 * direction, and timestamped. The server only routes opaque envelopes and says which logged-in member sent each; if
 * it lies, decryption fails. Since the SDP (with its DTLS fingerprint) is sealed, only the real member can complete
 * the connection, so the server can't sit in the middle of a call, and media only flows to verified peers.
 */

import type { Socket } from "socket.io-client";
import { importPublicKey } from "./crypto";

/** Signals older or newer than this are refused (replays, broken clocks). */
export const SIGNAL_MAX_SKEW_MS = 2 * 60_000;

const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AES key for signals from `from` to `to` in one room. */
export async function signalKey(myPrivate: CryptoKey, peerPublicBase64: string, roomId: string, from: string, to: string): Promise<CryptoKey> {
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: await importPublicKey(peerPublicBase64) }, myPrivate, 256);
  const hkdf = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(roomId), info: enc.encode(`relay-call|${from}|${to}`) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function sealSignal(key: CryptoKey, data: unknown, now = Date.now()): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify({ ts: now, data }))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

/** The signal's data, or null if it doesn't decrypt with this key or is stale. */
export async function openSignal<T>(key: CryptoKey, sealed: string, now = Date.now()): Promise<T | null> {
  try {
    const raw = unb64(sealed);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
    const { ts, data } = JSON.parse(new TextDecoder().decode(pt)) as { ts: number; data: T };
    return typeof ts === "number" && Math.abs(now - ts) <= SIGNAL_MAX_SKEW_MS ? data : null;
  } catch {
    return null;
  }
}

export type SecureSignalOptions = {
  /** This device's ECDH key pair and key hash; null while there is no identity. */
  me: () => { keyPair: CryptoKeyPair; keyHash: string } | null;
  /** A device's ECDH public key (base64), or undefined if it isn't a current device of a current member. */
  publicKeyFor: (deviceKeyHash: string) => string | undefined;
  /** Members of the current call's conversation; signals to or from anyone else are dropped. */
  allowed: () => Set<string> | null;
  room: () => string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io listener signature
type Handler = (...args: any[]) => void;

/**
 * Wrap a call socket so `emit("signal", { to, ...data })` seals `data` for that peer and `on("signal", h)` hands `h`
 * only signals that open, as `{ from, ...data }`. Peers' keyHashes come from the server's "members"/"peer_joined"
 * (the logged-in member behind each socket). Signals to and from each peer stay in order.
 */
export function secureSignalSocket(raw: Socket, opts: SecureSignalOptions): Socket {
  // Socket id -> the member and the device behind it (from the server's login sessions).
  const peers = new Map<string, { member: string; device: string }>();
  const note = (m: { id?: string; keyHash?: string; device?: string }) => {
    if (m?.id && m.keyHash) peers.set(m.id, { member: m.keyHash, device: m.device ?? m.keyHash });
  };
  // onAny, not on: the call code clears its own listeners with off(event), which would remove these too.
  raw.onAny((event: string, p: unknown) => {
    if (event === "members" && Array.isArray(p)) p.forEach(note);
    else if (event === "peer_joined" && p && typeof p === "object") note(p as { id?: string });
    else if (event === "peer_left" && typeof p === "string") peers.delete(p);
  });

  const outChains = new Map<string, Promise<void>>();
  const inChains = new Map<string, Promise<void>>();
  const wrapped = new Map<Handler, Handler>();

  // Sealed device to device; allowed by member (any device of a conversation member).
  const keyFor = async (peer: { member: string; device: string }, from: string, to: string) => {
    const me = opts.me();
    const pub = opts.publicKeyFor(peer.device);
    const allowed = opts.allowed();
    if (!me || !pub || !allowed?.has(peer.member)) return null;
    return signalKey(me.keyPair.privateKey, pub, opts.room(), from, to);
  };

  const sendSignal = (payload: { to: string } & Record<string, unknown>) => {
    const { to, ...data } = payload;
    const run = async () => {
      const me = opts.me();
      const peer = peers.get(to);
      if (!me || !peer) return;
      const key = await keyFor(peer, me.keyHash, peer.device);
      if (key) raw.emit("signal", { to, sealed: await sealSignal(key, data) });
    };
    const next = (outChains.get(to) ?? Promise.resolve()).then(run, run);
    outChains.set(to, next.catch(() => {}));
  };

  const wrap = (h: Handler): Handler => {
    const w = ((payload: { from?: string; fromKeyHash?: string; fromDevice?: string; sealed?: string }) => {
      const from = payload?.from;
      if (!from || typeof payload.sealed !== "string" || !payload.fromKeyHash) return;
      const run = async () => {
        const me = opts.me();
        const peer = peers.get(from);
        const device = payload.fromDevice ?? payload.fromKeyHash!;
        if (!me || !peer || peer.member !== payload.fromKeyHash || peer.device !== device) return;
        const key = await keyFor(peer, device, me.keyHash);
        const data = key && (await openSignal<Record<string, unknown>>(key, payload.sealed!));
        if (data) (h as (p: unknown) => void)({ ...data, from });
      };
      const next = (inChains.get(from) ?? Promise.resolve()).then(run, run);
      inChains.set(from, next.catch(() => {}));
    }) as Handler;
    wrapped.set(h, w);
    return w;
  };

  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "emit") {
        return (event: string, ...args: unknown[]) => {
          if (event === "signal") {
            sendSignal(args[0] as { to: string });
            return receiver;
          }
          return target.emit(event, ...args);
        };
      }
      if (prop === "on" || prop === "off") {
        return (event: string, h?: Handler) => {
          if (event === "signal" && h) {
            if (prop === "on") target.on(event, wrap(h));
            else if (wrapped.has(h)) {
              target.off(event, wrapped.get(h)!);
              wrapped.delete(h);
            }
            return receiver;
          }
          if (prop === "on") target.on(event, h as Handler);
          else if (h) target.off(event, h);
          else target.off(event);
          return receiver;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Socket;
}
