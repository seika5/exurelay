/**
 * Exurelay service worker (DESIGN.md §9): keeps the app working offline and shows push notifications.
 *
 * - Offline: the app's own files only (same origin, GET). Pages are network-first, hashed build files cache-first.
 *   Nothing from any Exurelay server (messages, keys) is ever cached here.
 * - Push: only @mentions and call rings. The payload is encrypted device to device (relay-web/src/lib/push.ts). In
 *   app-storage mode this device's key is in IndexedDB as a non-extractable CryptoKey, which a service worker can
 *   use: decrypt, then show it with *your* name for the sender. Otherwise (folder mode, or anything unexpected) the
 *   notification is generic.
 */
const CACHE = "relay-app-v1";
// Paths relative to where the app is served (a domain's root, or /<repo> on a GitHub Pages project site).
const BASE = new URL(self.registration.scope).pathname;
const SHELL = [BASE, `${BASE}manifest.webmanifest`, `${BASE}icon-192.png`, `${BASE}icon-512.png`];
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(`${BASE}_next/static/`)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
            return res;
          })
      )
    );
    return;
  }
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === "navigate" || SHELL.includes(url.pathname))) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match(BASE) : Response.error())))
  );
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function idb(store, key) {
  return new Promise((resolve) => {
    const open = indexedDB.open("relay");
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(store)) return resolve(undefined), db.close();
      const req = db.transaction(store).objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      req.transaction.oncomplete = () => db.close();
    };
  });
}

async function openPush(data) {
  const p = JSON.parse(data.payload);
  const identity = await idb("identities", data.server);
  const peers = await idb("pushPeers", data.server);
  if (!identity || !peers || p.v !== 1 || p.to !== identity.keyHash) return null;
  const peer = peers.peers.find((x) => x.device === p.from);
  if (!peer) return null;
  const pub = await crypto.subtle.importKey("raw", unb64(peer.publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, identity.keyPair.privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("relay-push"), info: enc.encode(`${p.from}|${p.to}`) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const content = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(p.iv) }, key, unb64(p.ct))));
  // The device must belong to the member the push names, and it must be recent.
  if (content.member !== peer.member || typeof content.ts !== "number" || Date.now() - content.ts > MAX_AGE_MS) return null;
  return { ...content, name: peer.name };
}

// Nothing about who or where: a notification can show on a locked screen. The app shows the rest once opened.
function text(kind) {
  return kind === "ring" ? "Incoming call" : "You were mentioned";
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        // not ours
      }
      let content = null;
      try {
        content = await openPush(data);
      } catch {
        content = null;
      }
      // The app is on screen: it shows the mention or call itself, so no banner. Safari still needs every push to show
      // a notification (or it drops the subscription), so show one and take it away at once.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const inApp = windows.some((c) => c.visibilityState === "visible");
      const tag = inApp ? "relay-in-app" : data.kind === "ring" ? "relay-ring" : undefined;
      // Every push must show a notification (Safari revokes subscriptions that don't).
      // The message is the title: iPhone already adds "from Exurelay" under it, so an "Exurelay" title only repeats it.
      await self.registration.showNotification(text(data.kind), {
        icon: `${BASE}icon-192.png`,
        badge: `${BASE}icon-192.png`,
        tag,
        silent: inApp,
      });
      if (inApp) for (const n of await self.registration.getNotifications({ tag })) n.close();
      // A ring with the app open: tell the app, which marks that chat (no banner, and no call screen pops up).
      if (inApp && data.kind === "ring" && content) {
        for (const c of windows) c.postMessage({ type: "relay-ring", server: data.server, member: content.member, group: content.group, ts: content.ts });
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      return open ? open.focus() : self.clients.openWindow(BASE);
    })
  );
});
