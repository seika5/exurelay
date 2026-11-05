/**
 * Which relay server this app talks to, and which admin signing keys it trusts for that server.
 *
 * One app build (the official PWA, a fork, a local build) can serve many independently hosted servers, so the
 * server isn't baked in. A member joins with a join code from their admin: the server URL plus the admins'
 * signing keys. The app pins both on first use. Later admin changes arrive inside the admin-signed member list,
 * signed by an admin this device already trusts, so the server can never swap in its own admin.
 *
 * An app can join several servers and switch between them; one is active at a time. Everything else stored per
 * server (tokens, rollback state) is keyed by its URL (serverScopedKey), so switching keeps each server's state.
 *
 * A build may still preset a server with NEXT_PUBLIC_API_URL (+ NEXT_PUBLIC_ADMIN_SIGNING_KEYS); that only seeds
 * the first run.
 */

export type ServerConfig = {
  /** Normalized origin (+ optional path), no trailing slash. */
  url: string;
  /** Pinned admin signing keys (base64 raw ECDSA P-256). Empty while the first admin is setting up a new server. */
  admins: string[];
};

export type JoinCode = { type: "relay-join"; server: string; admins: string[] };

const STORAGE_KEY = "relay.servers";
/** Phase 3 first shipped with a single server under this key. */
const LEGACY_KEY = "relay.server";
export const JOIN_PREFIX = "RELAY-JOIN:";

type Stored = { active: string | null; servers: ServerConfig[] };

let active: ServerConfig | null = null;

function parseConfig(c: unknown): ServerConfig | null {
  const o = c as { url?: unknown; admins?: unknown } | null;
  if (typeof o?.url !== "string" || !Array.isArray(o.admins)) return null;
  return { url: o.url, admins: o.admins.filter((a: unknown): a is string => typeof a === "string") };
}

function readStored(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const servers = (Array.isArray(s?.servers) ? s.servers : []).map(parseConfig).filter(Boolean) as ServerConfig[];
      const act = typeof s?.active === "string" && servers.some((c) => c.url === s.active) ? s.active : null;
      return { active: act, servers };
    }
    const legacy = parseConfig(JSON.parse(localStorage.getItem(LEGACY_KEY) || "null"));
    if (legacy) return { active: legacy.url, servers: [legacy] };
  } catch {
    // ignore
  }
  return { active: null, servers: [] };
}

function writeStored(s: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}

/** Server preset by this build, if any. Needs both the URL and the admin keys; a URL alone only pre-fills setup. */
export function presetServer(): ServerConfig | null {
  const url = process.env.NEXT_PUBLIC_API_URL;
  const admins = (process.env.NEXT_PUBLIC_ADMIN_SIGNING_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!url || admins.length === 0) return null;
  try {
    return { url: normalizeServerUrl(url), admins };
  } catch {
    return null;
  }
}

/** The active server: saved, otherwise the build's preset (only while no server has ever been joined). */
export function loadServerConfig(): ServerConfig | null {
  const s = readStored();
  active = s.servers.find((c) => c.url === s.active) ?? (s.servers.length === 0 ? presetServer() : null);
  return active;
}

/** Every server this app has joined. */
export function listServers(): ServerConfig[] {
  return readStored().servers;
}

/** Add or update a server and make it the active one. */
export function saveServerConfig(config: ServerConfig) {
  const s = readStored();
  writeStored({ active: config.url, servers: [...s.servers.filter((c) => c.url !== config.url), config] });
  active = config;
}

/** Make an already-joined server active. */
export function switchServerConfig(url: string): ServerConfig | null {
  const s = readStored();
  const next = s.servers.find((c) => c.url === url) ?? null;
  if (next) {
    writeStored({ ...s, active: url });
    active = next;
  }
  return next;
}

/** Forget a server. If it was active, the next joined server (if any) becomes active; that one is returned. */
export function removeServerConfig(url: string): ServerConfig | null {
  const s = readStored();
  const servers = s.servers.filter((c) => c.url !== url);
  const next = s.active === url ? servers[0] ?? null : servers.find((c) => c.url === s.active) ?? null;
  writeStored({ active: next?.url ?? null, servers });
  active = next;
  return next;
}

/** Base URL for API and socket calls. Throws if no server has been chosen yet. */
export function getServerUrl(): string {
  const c = active ?? loadServerConfig();
  if (!c) throw new Error("No server chosen yet");
  return c.url;
}

/** Per-server localStorage key, so state from one server never leaks into another. */
export function serverScopedKey(name: string): string {
  return `${name}:${getServerUrl()}`;
}

/** https only, except for local testing. Returns origin + path without a trailing slash. */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("The server address must start with https://");
  if (u.search || u.hash || u.username || u.password) throw new Error("Use just the server address, e.g. https://relay.example.com");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

export function createJoinCode(config: ServerConfig): string {
  const code: JoinCode = { type: "relay-join", server: config.url, admins: config.admins };
  return JOIN_PREFIX + b64url(JSON.stringify(code));
}

/** A link that opens this app and offers to join. The code sits in the #fragment, which browsers never send. */
export function joinLink(code: string, origin = window.location.origin + window.location.pathname): string {
  return `${origin}#join=${code.slice(JOIN_PREFIX.length)}`;
}

/** Accepts a RELAY-JOIN: code or a join link. */
export function readJoinCode(text: string): { ok: true; config: ServerConfig } | { ok: false; error: string } {
  const t = text.trim();
  let payload: string | null = null;
  if (t.startsWith(JOIN_PREFIX)) payload = t.slice(JOIN_PREFIX.length);
  else {
    const m = t.match(/#join=([A-Za-z0-9_-]+)/);
    if (m) payload = m[1];
  }
  if (!payload) return { ok: false, error: "Not an Exurelay join code or link." };
  try {
    const c = JSON.parse(unb64url(payload)) as JoinCode;
    if (c.type !== "relay-join" || typeof c.server !== "string" || !Array.isArray(c.admins) || c.admins.length === 0) {
      return { ok: false, error: "The join code is damaged." };
    }
    if (!c.admins.every((a) => typeof a === "string" && /^[A-Za-z0-9+/]+=*$/.test(a))) return { ok: false, error: "The join code is damaged." };
    return { ok: true, config: { url: normalizeServerUrl(c.server), admins: c.admins } };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message.startsWith("The server") ? e.message : "The join code is damaged." };
  }
}

/** If the page was opened with a #join= link, return it and strip it from the address bar. */
export function takeJoinFromLocation(): string | null {
  if (typeof window === "undefined" || !window.location.hash.startsWith("#join=")) return null;
  const hash = window.location.hash;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return hash;
}

/**
 * Whether a server someone is setting up is ready to claim: "ready" (answering, no member list yet), "claimed"
 * (it already has one: join with a code instead), or "starting" (not answering yet, or answering with an error,
 * as a freshly created server does for its first few minutes while it installs and gets its HTTPS certificate).
 */
export async function checkNewServer(url: string, timeoutMs = 8000): Promise<"ready" | "claimed" | "starting"> {
  try {
    const res = await fetch(`${normalizeServerUrl(url)}/api/directory`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "starting";
    const body = (await res.json()) as { directory?: unknown };
    return body.directory ? "claimed" : "ready";
  } catch {
    return "starting";
  }
}
