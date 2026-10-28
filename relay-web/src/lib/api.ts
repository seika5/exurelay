import type { SignedEnvelope } from "./signed";
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
 * Post blobs (each exactly 65536 bytes) in one request, paid for with one anonymous token.
 * recipients[i] is the recipient key hash for blobs[i].
 */
export async function postBlobs(recipients: string[], blobs: ArrayBuffer[]): Promise<{ ids: string[]; expiresAt: string }> {
  const body = new Uint8Array(blobs.reduce((n, b) => n + b.byteLength, 0));
  let offset = 0;
  for (const b of blobs) {
    body.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  const res = await tokenFetch(`/api/blobs?to=${recipients.map(encodeURIComponent).join(",")}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

export async function getBlobs(recipientKeyHash: string): Promise<{ id: string; payload: string; expiresAt: string }[]> {
  const res = await tokenFetch(`/api/blobs?recipientKeyHash=${encodeURIComponent(recipientKeyHash)}`, { cache: "no-store" });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

/** Short-lived ICE servers (STUN + TURN credentials) from the relay. Empty if the relay has no TURN configured. */
export async function getIceServers(): Promise<RTCIceServer[]> {
  const res = await tokenFetch(`/api/turn/credentials`, { cache: "no-store" });
  if (!res.ok) throw await errorFrom(res);
  const data = await res.json();
  return Array.isArray(data?.iceServers) ? data.iceServers : [];
}

export type DirectoryResponse = { directory: SignedEnvelope | null; profiles: SignedEnvelope[]; departures?: SignedEnvelope[] };

/** Newest admin-signed member directory and member-signed profiles. Unverified: callers must check signatures. */
export async function getDirectory(): Promise<DirectoryResponse> {
  const res = await fetch(`${getServerUrl()}/api/directory`, { cache: "no-store" });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${getServerUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
}

export const publishDirectory = (envelope: SignedEnvelope) => postJson("/api/directory", envelope);
export const publishProfile = (envelope: SignedEnvelope) => postJson("/api/directory/profile", envelope);
/** Signed by the member themself: the server deletes them at once and drops their sessions and pending messages. */
export const postLeave = (envelope: SignedEnvelope) => postJson("/api/directory/leave", envelope);

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
