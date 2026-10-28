/**
 * Challenge-response login (DESIGN.md §6). The server sends a nonce; we sign
 * { type: "relay-login", keyHash, nonce, server } with our ECDSA key and get a 15-minute session.
 * The session is identified: it's used only to refill anonymous tokens, for admin requests, and for the socket.
 */

import { getServerUrl } from "./server";
import { signRecord } from "./signed";

type Signer = { keyHash: string; signingPrivateKey: CryptoKey };
export type Session = { token: string; expiresAt: number; isAdmin: boolean };

let signer: Signer | null = null;
let current: Session | null = null;
let pending: Promise<Session> | null = null;

/** Set (or clear) the identity used for logins. Drops any session from a previous identity or server. */
export function setSigner(next: Signer | null) {
  signer = next;
  current = null;
  pending = null;
}

export function dropSession() {
  current = null;
}

async function login(): Promise<Session> {
  if (!signer) throw new Error("No identity");
  const server = getServerUrl();
  const c = await fetch(`${server}/api/auth/challenge`, { method: "POST" });
  if (!c.ok) throw new Error(`Login failed (${c.status})`);
  const { nonce } = await c.json();
  const env = await signRecord(signer.signingPrivateKey, { type: "relay-login", keyHash: signer.keyHash, nonce, server });
  const res = await fetch(`${server}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(env),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ? `Login failed: ${data.error}` : `Login failed (${res.status})`);
  return { token: data.session, expiresAt: data.expiresAt, isAdmin: !!data.isAdmin };
}

/** A valid session, logging in if there's none or it's about to expire. */
export async function getSession(): Promise<Session> {
  if (current && current.expiresAt - Date.now() > 30_000) return current;
  if (!pending) {
    pending = login()
      .then((s) => {
        current = s;
        return s;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/** fetch() with the session as a Bearer token; logs in again once if the server forgot it (e.g. restarted). */
export async function sessionFetch(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const s = await getSession();
    const res = await fetch(`${getServerUrl()}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${s.token}` },
    });
    if (res.status === 401 && attempt === 0) {
      dropSession();
      continue;
    }
    return res;
  }
}
