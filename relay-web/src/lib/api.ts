import type { SignedEnvelope } from "./signed";
import type { StoredBlob } from "./sealed";
import { getServerUrl } from "./server";
import { sessionFetch } from "./session";
import { tokenFetch } from "./tokens";

/** A request the server answered with an error status. */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  const data = await res.json().catch(() => null);
  return new ApiError(data?.error || `Request failed (${res.status})`, res.status);
}

/**
 * Post one batch of blobs (each exactly the server's blob size), in order, paid for with one anonymous token.
 * Protocol v2: no recipients; every member downloads every blob (sealed.ts).
 */
export async function postBlobs(blobs: Uint8Array[]): Promise<void> {
  const body = new Uint8Array(blobs.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of blobs) {
    body.set(b, offset);
    offset += b.length;
  }
  const res = await tokenFetch("/api/blobs", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  if (!res.ok) throw await errorFrom(res);
}

/** The next page of blobs after a cursor (a blob seq; "0" from the start). Binary format: see relay-server blob.js. */
export async function getBlobsSince(since: string): Promise<{ blobs: StoredBlob[]; more: boolean }> {
  const res = await tokenFetch(`/api/blobs?since=${encodeURIComponent(since)}`, { cache: "no-store" });
  if (!res.ok) throw await errorFrom(res);
  const buf = new Uint8Array(await res.arrayBuffer());
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = v.getUint32(0);
  const more = buf[4] === 1;
  const blobs: StoredBlob[] = [];
  let o = 5;
  for (let i = 0; i < count; i++) {
    const seq = v.getBigUint64(o).toString();
    const expiresAt = Number(v.getBigUint64(o + 8));
    const len = v.getUint32(o + 16);
    blobs.push({ seq, expiresAt, payload: buf.slice(o + 20, o + 20 + len) });
    o += 20 + len;
  }
  return { blobs, more };
}

/** Short-lived ICE servers (STUN + TURN credentials) from the relay. Empty if the relay has no TURN configured. */
export async function getIceServers(): Promise<RTCIceServer[]> {
  const res = await tokenFetch(`/api/turn/credentials`, { cache: "no-store" });
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json();
  return Array.isArray(data?.iceServers) ? data.iceServers : [];
}

export type DirectoryResponse = {
  directory: SignedEnvelope | null;
  profiles: SignedEnvelope[];
  departures?: SignedEnvelope[];
  devices?: SignedEnvelope[];
  deviceRevocations?: SignedEnvelope[];
};

/** Newest admin-signed member directory and member-signed profiles. Unverified: callers must check signatures. */
export async function getDirectory(): Promise<DirectoryResponse> {
  const res = await fetch(`${getServerUrl()}/api/directory`, { cache: "no-store" });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(`${getServerUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
}

/** setupCode: only for the first member list, on a server set up with a one-time setup code (deploy/install.sh). */
export const publishDirectory = (envelope: SignedEnvelope, setupCode?: string) =>
  postJson("/api/directory", envelope, setupCode ? { "X-Relay-Setup": setupCode.trim() } : {});
export const publishProfile = (envelope: SignedEnvelope) => postJson("/api/directory/profile", envelope);
/** Signed by the member themself: the server deletes them at once and drops their sessions and pending messages. */
export const postLeave = (envelope: SignedEnvelope) => postJson("/api/directory/leave", envelope);
/** Link a device: a certificate signed by one of the member's devices. */
export const postDeviceCert = (envelope: SignedEnvelope) => postJson("/api/directory/device", envelope);
/** Unlink a device: signed by one of the member's devices (including that one). */
export const postDeviceRevoke = (envelope: SignedEnvelope) => postJson("/api/directory/device/revoke", envelope);

// ---------------------------------------------------------------------------
// Admin (logged-in admin session)
// ---------------------------------------------------------------------------

export type ServerStatus = {
  members: number;
  blobs: number;
  blobBytes: number;
  directoryVersion: number;
  tokens: { ratePerMinute: number; burst: number; issuedToday: number };
  issuerKeys: { id: string; reason: string; notBefore: number; notAfter: number; directoryVersion?: number }[];
  turn: { configured: boolean; servers: number };
};

export async function getServerStatus(): Promise<ServerStatus> {
  const res = await sessionFetch("/api/admin/status", { cache: "no-store" });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

export async function getAdminLabels(): Promise<Record<string, string>> {
  const res = await sessionFetch("/api/admin/labels", { cache: "no-store" });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()).labels ?? {};
}

export async function setAdminLabel(keyHash: string, label: string): Promise<void> {
  const res = await sessionFetch(`/api/admin/labels/${encodeURIComponent(keyHash)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw await errorFrom(res);
}
