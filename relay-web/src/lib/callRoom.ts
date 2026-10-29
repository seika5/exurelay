import type { DecryptedMessage } from "@/lib/blobPayload";

/**
 * Call rooms (DESIGN.md §7). Whoever starts a call picks a random room id and announces it in the encrypted
 * "call started" message, so only the conversation's members know it: nobody can guess a room or squat it ahead of
 * time. Everyone else joins the room named by the conversation's latest "started" call event, until an "ended".
 */
export function newRoomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return "room-" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The room of the conversation's ongoing call, if its latest call event says one started. Messages in sentAt order. */
export function activeCallRoom(messages: DecryptedMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== "call_event") continue;
    return m.event === "started" && typeof m.roomId === "string" && /^room-[A-Za-z0-9_-]{16,64}$/.test(m.roomId) ? m.roomId : null;
  }
  return null;
}
