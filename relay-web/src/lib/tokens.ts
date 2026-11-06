/**
 * Anonymous membership tokens (DESIGN.md §6): RFC 9474 RSABSSA-SHA384-PSS-Randomized via @cloudflare/blindrsa-ts.
 *
 * - The wallet keeps a pool of unspent tokens per server. One token pays for one request (send, sync, TURN).
 * - When the pool runs low it refills at a random moment in the next couple of minutes (immediately if empty):
 *   log in, send blinded messages, unblind the signatures. The server signs without seeing what it signs.
 * - Issuer keys must follow the schedule (one per UTC day, or one per admin-signed removal); anything else is
 *   refused, so a server can't split members into small groups with extra keys.
 * - Every message carries the sender's issuer key id. If a member's key is one this server never showed us,
 *   the server may be tagging members with per-member keys, and we warn.
 * Must match relay-server/src/lib/tokens.js.
 */

import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { getServerUrl, serverScopedKey } from "./server";
import { sessionFetch } from "./session";
import type { Directory } from "./signed";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const POOL_TARGET = 100;
export const REFILL_BELOW = 40;
const REFILL_MAX_DELAY_MS = 2 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const KEYS_TTL_MS = 5 * 60 * 1000;

export type IssuerKey = {
  id: string;
  publicKey: string;
  reason: "daily" | "removal";
  notBefore: number;
  notAfter: number;
  directoryVersion?: number;
};

type Token = { keyId: string; msg: string; sig: string };

const suite = RSABSSA.SHA384.PSS.Randomized();
export const utcMidnight = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;

const toB64url = (b: Uint8Array) => btoa(String.fromCharCode(...Array.from(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...Array.from(b)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------------------
// Key schedule checks
// ---------------------------------------------------------------------------

/**
 * Which published issuer keys follow the schedule. A daily key starts at UTC midnight and lasts 48 h, one per
 * day. A removal key needs its own removal entry in the admin-signed directory from the 24 h before it, and
 * lasts until the second UTC midnight after it starts. seenDaily remembers which key this device saw for each
 * day, so a server can't show us a different one later.
 */
export function checkKeySchedule(
  keys: IssuerKey[],
  directory: Directory | null,
  seenDaily: Record<string, string> = {}
): { accepted: IssuerKey[]; rejected: { key: IssuerKey; reason: string }[] } {
  const accepted: IssuerKey[] = [];
  const rejected: { key: IssuerKey; reason: string }[] = [];
  const perDay = new Map<number, IssuerKey[]>();
  for (const k of keys) {
    if (k.reason === "daily") perDay.set(k.notBefore, [...(perDay.get(k.notBefore) ?? []), k]);
  }
  const removals = [...(directory?.removed ?? [])].sort((a, b) => a.removedAt - b.removedAt);
  const usedRemovals = new Set<number>();
  for (const k of [...keys].sort((a, b) => a.notBefore - b.notBefore)) {
    if (k.reason === "daily") {
      if (k.notBefore !== utcMidnight(k.notBefore) || k.notAfter - k.notBefore !== 2 * DAY_MS) {
        rejected.push({ key: k, reason: "off-schedule daily key" });
      } else if ((perDay.get(k.notBefore)?.length ?? 0) > 1) {
        rejected.push({ key: k, reason: "two keys for the same day" });
      } else if (seenDaily[k.notBefore] && seenDaily[k.notBefore] !== k.id) {
        rejected.push({ key: k, reason: "the server changed this day's key" });
      } else accepted.push(k);
      continue;
    }
    if (k.reason === "removal") {
      const i = removals.findIndex(
        (r, idx) => !usedRemovals.has(idx) && r.removedAt <= k.notBefore + CLOCK_SKEW_MS && k.notBefore - r.removedAt <= DAY_MS
      );
      if (i < 0) rejected.push({ key: k, reason: "no matching removal in the member list" });
      else if (k.notAfter !== utcMidnight(k.notBefore) + 2 * DAY_MS) rejected.push({ key: k, reason: "off-schedule removal key" });
      else {
        usedRemovals.add(i);
        accepted.push(k);
      }
      continue;
    }
    rejected.push({ key: k, reason: "unknown key type" });
  }
  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Wallet state
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
let warning: string | null = null;
let directoryRef: Directory | null = null;
let keysCache: { at: number; url: string; all: IssuerKey[]; accepted: IssuerKey[]; rejected: string[] } | null = null;
let refillTimer: ReturnType<typeof setTimeout> | null = null;
let refilling: Promise<void> | null = null;
let lastIssuer: string | null = null;

/** Problems with the server's tokens worth showing the user (tag suspicion, refused keys). */
export function getTokenWarning() {
  return warning;
}
export function subscribeTokenWarning(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setWarning(w: string | null) {
  if (w === warning) return;
  warning = w;
  listeners.forEach((fn) => fn());
}

/** The verified directory, for checking removal keys. Called by IdentityContext whenever it changes. */
export function setTokenDirectory(d: Directory | null) {
  directoryRef = d;
  keysCache = null;
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(serverScopedKey(name));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(name: string, value: unknown) {
  try {
    localStorage.setItem(serverScopedKey(name), JSON.stringify(value));
  } catch {
    // Storage unavailable: tokens last for this page only.
  }
}

const readPool = () => readJson<Token[]>("relay.tokens", []);
const writePool = (p: Token[]) => writeJson("relay.tokens", p);

/** Forget this server's tokens and key history (leaving the server, or logging out). */
export function clearWallet() {
  try {
    localStorage.removeItem(serverScopedKey("relay.tokens"));
    localStorage.removeItem(serverScopedKey("relay.issuerSeen"));
  } catch {
    // ignore
  }
  resetWalletMemory();
}

/** Forget what's held in memory for the active server (its stored wallet stays). Call when switching servers. */
export function resetWalletMemory() {
  keysCache = null;
  lastIssuer = null;
  checkedIssuers.clear();
  if (refillTimer) clearTimeout(refillTimer);
  refillTimer = null;
  setWarning(null);
}

export async function loadIssuerKeys(force = false): Promise<NonNullable<typeof keysCache>> {
  const url = getServerUrl();
  if (!force && keysCache && keysCache.url === url && Date.now() - keysCache.at < KEYS_TTL_MS) return keysCache;
  const res = await fetch(`${url}/api/tokens/keys`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't load token keys (${res.status})`);
  const all: IssuerKey[] = (await res.json()).keys ?? [];
  const seen = readJson<Record<string, string>>("relay.issuerSeen", {});
  const { accepted, rejected } = checkKeySchedule(all, directoryRef, seen);
  for (const k of accepted) if (k.reason === "daily") seen[k.notBefore] = k.id;
  // Forget days older than a week.
  for (const day of Object.keys(seen)) if (Number(day) < Date.now() - 8 * DAY_MS) delete seen[day];
  writeJson("relay.issuerSeen", seen);
  const live = (k: IssuerKey) => k.notBefore <= Date.now() + CLOCK_SKEW_MS && k.notAfter > Date.now();
  if (rejected.some((r) => live(r.key))) {
    setWarning(`This server published a token key that breaks the schedule (${rejected[0].reason}). It may be trying to track members.`);
  }
  keysCache = { at: Date.now(), url, all, accepted, rejected: rejected.map((r) => r.key.id) };
  return keysCache;
}

/** The newest accepted key that's valid now: the one to refill with. */
function issuingKey(keys: IssuerKey[]): IssuerKey | null {
  const now = Date.now();
  const valid = keys.filter((k) => k.notBefore <= now + CLOCK_SKEW_MS && k.notAfter > now);
  return valid.sort((a, b) => a.notBefore - b.notBefore).at(-1) ?? null;
}

async function importIssuerKey(k: IssuerKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", fromB64(k.publicKey) as BufferSource, { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);
}

/** Get up to POOL_TARGET tokens: log in, blind, have them signed, unblind and check each signature. */
async function refillNow(): Promise<void> {
  const { accepted } = await loadIssuerKeys();
  const key = issuingKey(accepted);
  if (!key) throw new Error("The server has no usable token key right now.");
  const pool = readPool().filter((t) => accepted.some((k) => k.id === t.keyId && k.notAfter > Date.now()));
  writePool(pool);
  const want = POOL_TARGET - pool.length;
  if (want <= 0) return;
  try {
    await requestTokens(key, want);
  } catch (e) {
    // Over the server's rate limit: take whatever is available now. With nothing at all, the caller waits
    // (the send queue keeps its messages faded until then).
    if (e instanceof RateLimitError && e.remaining > 0) await requestTokens(key, e.remaining);
    else throw e;
  }
}

/** The server's per-member token rate limit: nothing to spend for `retryAfter` seconds. */
export class RateLimitError extends Error {
  constructor(public remaining: number, public retryAfter: number) {
    super("Token rate limit reached.");
  }
}

async function requestTokens(key: IssuerKey, want: number): Promise<void> {
  const pub = await importIssuerKey(key);
  const pending = [];
  for (let i = 0; i < want; i++) {
    const prepared = suite.prepare(crypto.getRandomValues(new Uint8Array(32)));
    const { blindedMsg, inv } = await suite.blind(pub, prepared);
    pending.push({ prepared, blindedMsg, inv });
  }
  const res = await sessionFetch("/api/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyId: key.id, blinded: pending.map((p) => toB64(p.blindedMsg)) }),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 409) {
    keysCache = null;
    throw new Error("The token key just changed; try again.");
  }
  if (res.status === 429) {
    throw new RateLimitError(Number(data?.remaining) || 0, Number(data?.retryAfter) || 5);
  }
  if (!res.ok || !Array.isArray(data?.signatures) || data.signatures.length !== pending.length) {
    throw new Error(data?.error || `Couldn't get tokens (${res.status})`);
  }
  const fresh: Token[] = [];
  for (let i = 0; i < pending.length; i++) {
    // finalize() verifies the unblinded signature, so a bad or tagged signature throws here.
    const sig = await suite.finalize(pub, pending[i].prepared, fromB64(data.signatures[i]), pending[i].inv);
    fresh.push({ keyId: key.id, msg: toB64url(pending[i].prepared), sig: toB64url(sig) });
  }
  writePool([...readPool(), ...fresh]);
}

function refill(): Promise<void> {
  if (!refilling) {
    refilling = refillNow().finally(() => {
      refilling = null;
    });
  }
  return refilling;
}

/** Top up later, at a random moment, so refills don't line up with what we do next. */
function scheduleRefill() {
  if (refillTimer || refilling) return;
  refillTimer = setTimeout(() => {
    refillTimer = null;
    refill().catch(() => {});
  }, Math.random() * REFILL_MAX_DELAY_MS);
}

/** Take one token out of the pool (it's removed before use, so it's never offered twice). */
async function takeToken(): Promise<Token> {
  const { accepted } = await loadIssuerKeys();
  const ok = (t: Token) => accepted.some((k) => k.id === t.keyId && k.notAfter > Date.now() + 10_000);
  let pool = readPool().filter(ok);
  writePool(pool);
  if (pool.length === 0) {
    await refill();
    pool = readPool().filter(ok);
    if (pool.length === 0) throw new Error("No tokens available.");
  }
  // Spend tokens from the oldest key first; they expire soonest.
  pool.sort((a, b) => (accepted.find((k) => k.id === a.keyId)?.notAfter ?? 0) - (accepted.find((k) => k.id === b.keyId)?.notAfter ?? 0));
  const [token, ...rest] = pool;
  writePool(rest);
  if (rest.length < REFILL_BELOW) scheduleRefill();
  lastIssuer = token.keyId;
  return token;
}

/** The issuer key id of our tokens, sent inside every message for the cross-check. */
export async function currentIssuerId(): Promise<string | undefined> {
  if (lastIssuer) return lastIssuer;
  try {
    return issuingKey((await loadIssuerKeys()).accepted)?.id;
  } catch {
    return undefined;
  }
}

/**
 * fetch() paid for with one anonymous token. If the server refuses the token, try again with another:
 * - first, after reloading the keys (probably a rotation, e.g. a removal, we haven't seen yet);
 * - then with a fresh stock: the saved pool itself is stale. On an iPhone the app can be closed before the pool
 *   with a spent token taken out is written to storage, so the next launch offers tokens the server has already seen.
 */
export async function tokenFetch(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const t = await takeToken();
    const res = await fetch(`${getServerUrl()}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), "Relay-Token": `${t.keyId}.${t.msg}.${t.sig}` },
    });
    if (res.status !== 401 || attempt >= 2 || (await res.clone().json().catch(() => null))?.code !== "token") return res;
    keysCache = null;
    if (attempt === 1) writePool([]);
  }
}

const checkedIssuers = new Set<string>();

/**
 * Cross-check another member's issuer key id (from a decrypted message). Everyone should be using keys the
 * server published to us too; a key we've never been shown means the server is giving members different keys.
 */
export async function checkPeerIssuer(issuerId: string): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(issuerId) || checkedIssuers.has(issuerId)) return;
  let keys = await loadIssuerKeys();
  if (!keys.all.some((k) => k.id === issuerId)) keys = await loadIssuerKeys(true);
  checkedIssuers.add(issuerId);
  if (!keys.all.some((k) => k.id === issuerId)) {
    setWarning(
      "Another member is using a token key this server never showed you. The server may be giving members different keys to tell them apart."
    );
  } else if (keys.rejected.includes(issuerId)) {
    setWarning("Another member is using a token key that breaks the schedule. The server may be trying to track members.");
  }
}
