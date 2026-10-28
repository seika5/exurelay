const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/** Post one blob (exactly 65536 bytes binary). */
export async function postBlobBinary(
  recipientKeyHash: string,
  body: ArrayBuffer
): Promise<{ id: string; expiresAt: string }> {
  const res = await fetch(`${API}/api/blobs?recipientKeyHash=${encodeURIComponent(recipientKeyHash)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getBlobs(recipientKeyHash: string): Promise<{ id: string; payload: string; expiresAt: string }[]> {
  const res = await fetch(`${API}/api/blobs?recipientKeyHash=${encodeURIComponent(recipientKeyHash)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/** Short-lived ICE servers (STUN + TURN credentials) from the relay. Empty if the relay has no TURN configured. */
export async function getIceServers(keyHash: string): Promise<RTCIceServer[]> {
  const res = await fetch(`${API}/api/turn/credentials?keyHash=${encodeURIComponent(keyHash)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return Array.isArray(data?.iceServers) ? data.iceServers : [];
}

export async function checkAllowed(keyHash: string): Promise<boolean> {
  const res = await fetch(`${API}/api/keys/allowed?keyHash=${encodeURIComponent(keyHash)}`);
  if (!res.ok) return false;
  const data = await res.json();
  return !!data?.allowed;
}
