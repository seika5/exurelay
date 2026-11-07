import type { DecryptedMessage } from "@/lib/blobPayload";
import { isRoomKey } from "@/lib/callIntro";

/**
 * Call rooms (DESIGN.md §7). Whoever starts a call picks a random room id and a random room secret and announces both
 * in the encrypted "call started" message, so only the conversation's members know them: nobody can guess a room or
 * squat it ahead of time, and only they can introduce themselves in it (callIntro.ts). Everyone else joins the call
 * named by the conversation's latest "started" call event, until an "ended".
 */
export function newRoomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return "room-" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A call: its room and secret. No roomKey means an older app started it; that call is joined the legacy way, logged
 * in (remove with the server's join_room).
 */
export type CallRoom = { roomId: string; roomKey?: string };

/** The conversation's ongoing call, if its latest call event says one started. Messages in sentAt order. */
export function activeCall(messages: DecryptedMessage[]): CallRoom | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== "call_event") continue;
    if (m.event !== "started" || typeof m.roomId !== "string" || !/^room-[A-Za-z0-9_-]{16,64}$/.test(m.roomId)) return null;
    return isRoomKey(m.roomKey) ? { roomId: m.roomId, roomKey: m.roomKey } : { roomId: m.roomId };
  }
  return null;
}
