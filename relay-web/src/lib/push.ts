/**
 * Push notifications for @mentions and call rings, and (if the admin allows and you turn it on) every message and
 * call start (DESIGN.md §9 "direct push (A)").
 *
 * The sender encrypts a tiny payload to each recipient device with a key from the static ECDH secret between the two
 * devices, and pays for the push with an anonymous token. The server wraps it in Web Push encryption and forwards it.
 * The service worker (public/sw.js) decrypts it with this device's key from IndexedDB and shows it using *your*
 * name for the sender (from the push peers list this app keeps, keystore.ts). In folder mode the keys aren't in
 * IndexedDB, so the notification is generic.
 */

import { importPublicKey } from "./crypto";
import { getServerUrl, listServers, serverScopedKey } from "./server";
import { sessionFetch } from "./session";
import { tokenFetch } from "./tokens";

/** "message" and "call" (every message, call started) go only to devices that turned them on, if the admin allows. */
export type PushKind = "mention" | "everyone" | "ring" | "message" | "call";
/** What a push says, encrypted: who (member keyHash) did what, and in which group (its shared name), if any. */
export type PushContent = { kind: PushKind; member: string; group?: string; ts: number };

const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** A push older than this is shown generically (it may be a replay). */
export const PUSH_MAX_AGE_MS = 24 * 60 * 60_000;

async function pushKey(myPrivate: CryptoKey, peerPublicBase64: string, from: string, to: string): Promise<CryptoKey> {
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: await importPublicKey(peerPublicBase64) }, myPrivate, 256);
  const hkdf = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("relay-push"), info: enc.encode(`${from}|${to}`) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt a push for one recipient device. The result goes in the server's notify request as that device's payload. */
export async function sealPush(
  myPrivate: CryptoKey,
  fromDevice: string,
  to: { keyHash: string; publicKey: string },
  content: PushContent
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pushKey(myPrivate, to.publicKey, fromDevice, to.keyHash);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(content))));
  return JSON.stringify({ v: 1, from: fromDevice, to: to.keyHash, iv: b64(iv), ct: b64(ct) });
}

/** The service worker's counterpart (public/sw.js does the same in plain JS). Null if it isn't for us or doesn't open. */
export async function openPush(
  myPrivate: CryptoKey,
  myDevice: string,
  senderPublicBase64: string,
  payload: string,
  now = Date.now()
): Promise<PushContent | null> {
  try {
    const p = JSON.parse(payload) as { v: number; from: string; to: string; iv: string; ct: string };
    if (p.v !== 1 || p.to !== myDevice) return null;
    const key = await pushKey(myPrivate, senderPublicBase64, p.from, p.to);
    const c = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(p.iv) }, key, unb64(p.ct)))) as PushContent;
    return typeof c.ts === "number" && now - c.ts < PUSH_MAX_AGE_MS ? c : null;
  } catch {
    return null;
  }
}

/** Devices with notifications on, for the active server: null if the server doesn't send them. Cached 2 minutes. */
type Pushable = { devices: Set<string>; all: Set<string> };
let pushable: { url: string; at: number; on: Pushable | null } | null = null;
const PUSHABLE_TTL_MS = 2 * 60_000;

const readPushable = (body: { devices: string[]; all?: string[] }): Pushable => ({ devices: new Set(body.devices), all: new Set(body.all ?? []) });

/** Which devices have notifications on, and which of those want every message too. Null if the server doesn't send them. */
async function pushableDevices(): Promise<Pushable | null> {
  const url = getServerUrl();
  if (pushable && pushable.url === url && Date.now() - pushable.at < PUSHABLE_TTL_MS) return pushable.on;
  const res = await sessionFetch("/api/push/devices", { cache: "no-store" });
  const on = res.ok ? readPushable(await res.json()) : null;
  if (res.ok || res.status === 503) pushable = { url, at: Date.now(), on };
  return on;
}

/**
 * Ask the server to push these recipient devices; resolves with how many went out and how many hit the limit.
 * Only devices that have notifications on are named, and nothing is sent if the server doesn't do push: a mention
 * of someone who can't be notified tells the server nothing.
 */
export async function sendPushes(
  kind: PushKind,
  me: { keyPair: CryptoKeyPair; deviceKeyHash: string },
  devices: { keyHash: string; publicKey: string }[],
  content: Omit<PushContent, "kind" | "ts">
): Promise<{ sent: number; limited: number }> {
  if (devices.length === 0) return { sent: 0, limited: 0 };
  const on = await pushableDevices();
  const wanted = kind === "message" || kind === "call" ? on?.all : on?.devices;
  const targets = wanted ? devices.filter((d) => wanted.has(d.keyHash)) : [];
  if (targets.length === 0) return { sent: 0, limited: 0 };
  const full: PushContent = { ...content, kind, ts: Date.now() };
  const items = await Promise.all(
    targets.slice(0, 64).map(async (d) => ({ device: d.keyHash, payload: await sealPush(me.keyPair.privateKey, me.deviceKeyHash, d, full) }))
  );
  const res = await tokenFetch("/api/push/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, items }),
  });
  // This server doesn't send notifications (503), or not every-message ones (403).
  if (res.status === 503 || res.status === 403) return { sent: 0, limited: 0 };
  if (!res.ok) throw new Error(`Couldn't send the notification (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// This device's subscription
// ---------------------------------------------------------------------------

export type PushState = "unsupported" | "denied" | "off" | "on" | "server-off";

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlBase64ToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return unb64((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
}

/** The browser has one push subscription per app address, shared by every server joined; this marks one server off. */
const PUSH_OFF_KEY = "relay.pushOff";
const isOffHere = (url = getServerUrl()) => {
  try {
    return localStorage.getItem(`${PUSH_OFF_KEY}:${url}`) === "1";
  } catch {
    return false;
  }
};
function setOffHere(off: boolean) {
  try {
    if (off) localStorage.setItem(serverScopedKey(PUSH_OFF_KEY), "1");
    else localStorage.removeItem(serverScopedKey(PUSH_OFF_KEY));
  } catch {
    // Storage blocked: the state just isn't remembered.
  }
}

/**
 * On only if this browser is subscribed and the server lists this device: the server drops a subscription the push
 * service refused (relay-server lib/pushErrors.js), so this shows off whenever notifications can't reach it. If the
 * server can't be asked just now, what this browser has decides.
 */
export async function pushState(myDevice: string): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  if (Notification.permission !== "granted" || isOffHere()) return "off";
  // Permission granted and not turned off here: re-register first (and subscribe again if iPhone dropped it).
  await syncPush().catch(() => {});
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return "off";
  try {
    const res = await sessionFetch("/api/push/devices", { cache: "no-store" });
    if (res.status === 503) return "server-off";
    if (!res.ok) return "on";
    const on = readPushable(await res.json());
    pushable = { url: getServerUrl(), at: Date.now(), on };
    return on.devices.has(myDevice) ? "on" : "off";
  } catch {
    return "on";
  }
}

/** Whether this device gets every message and call start too (as last read from the server). */
export async function notifyAllState(myDevice: string): Promise<boolean> {
  return (await pushableDevices())?.all.has(myDevice) ?? false;
}

/** Turn every-message and call-start notifications on or off for this device (notifications must be on). */
export async function setNotifyAll(on: boolean): Promise<void> {
  const res = await sessionFetch("/api/push/all", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on }),
  });
  if (!res.ok) throw new Error(on ? "Couldn't turn on every-message notifications" : "Couldn't turn them off");
  pushable = null;
}

/** Turn notifications off for this device on the active server; in the browser too if no other server uses them. */
export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    const r = await sessionFetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    if (!r.ok) throw new Error(`Couldn't turn off notifications (${r.status})`);
  }
  setOffHere(true);
  const elsewhere = listServers().some((s) => s.url !== getServerUrl() && !isOffHere(s.url));
  if (sub && !elsewhere) await sub.unsubscribe().catch(() => {});
  pushable = null;
  return "off";
}

/** Each step of turning notifications on gives up after this long (the permission prompt waits for you instead). */
const STEP_TIMEOUT_MS = 15_000;

function step<T>(p: Promise<T>, failure: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(failure)), STEP_TIMEOUT_MS);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    );
  });
}

/**
 * Turn notifications on for this device on the active server. Must run from a click (the permission prompt). Throws
 * with a message saying what went wrong, so the switch can say why it didn't turn on.
 */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  // No answer: the prompt was closed, or the browser didn't show one (some keep it quiet in the address bar).
  if (permission !== "granted") throw new Error("The browser didn't allow it. Allow notifications for this site (the icon by the address), then try again.");
  // Marked on before the rest: if the app is closed partway, the next launch finishes it (syncPush).
  setOffHere(false);
  const res = await step(fetch(`${getServerUrl()}/api/push/vapid`, { cache: "no-store" }), "The server didn't answer. Try again.");
  if (res.status === 503) return "server-off";
  if (!res.ok) throw new Error(`Couldn't reach the server (${res.status})`);
  const { publicKey } = (await res.json()) as { publicKey: string };
  const reg = await step(navigator.serviceWorker.ready, "The app isn't fully loaded yet. Reload the page and try again.");
  // Always a fresh subscription: an old one may be what the push service refused. Other servers joined here pick up
  // the new one the next time they're opened (syncPush).
  await (await reg.pushManager.getSubscription())?.unsubscribe().catch(() => {});
  let sub: PushSubscription;
  try {
    sub = await step(
      reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) as BufferSource }),
      "This browser's push service didn't answer. Try again, or use another browser."
    );
  } catch (e) {
    // e.g. Opera's push service refuses web apps' subscriptions ("push service error").
    if (e instanceof DOMException) throw new Error("This browser can't receive notifications from web apps. Chrome, Edge, Firefox and Safari can.");
    throw e;
  }
  const json = sub.toJSON();
  const r = await step(
    sessionFetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    }),
    "The server didn't answer. Try again."
  );
  if (!r.ok) throw new Error(`Couldn't turn on notifications (${r.status})`);
  pushable = null;
  return "on";
}

/** Whether a subscription was made with this server key (a subscription made with another can't receive its pushes). */
export function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const have = sub.options?.applicationServerKey;
  if (!have) return true; // the browser doesn't say: assume it's right
  const a = new Uint8Array(have);
  const b = urlBase64ToBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * On every launch with notifications on: tell the server again which subscription is this device's. The switch only
 * knows what this browser has; the server may not (this device's key changed, or the subscription was made with an
 * old server key, which the push service then refuses). Quiet: failures leave things as they were.
 */
export async function syncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted" || isOffHere()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  let sub = await reg.pushManager.getSubscription();
  const res = await fetch(`${getServerUrl()}/api/push/vapid`, { cache: "no-store" });
  if (!res.ok) return;
  const { publicKey } = (await res.json()) as { publicKey: string };
  // iPhone sometimes drops a subscription without saying so (and never fires pushsubscriptionchange): with permission
  // still granted, make a new one. Likewise if it was made with another server key.
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) as BufferSource });
  const json = sub.toJSON();
  await sessionFetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  pushable = null;
}
