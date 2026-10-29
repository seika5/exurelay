/**
 * Call rooms: random ids, and joining the room named by the conversation's latest "started" event.
 */
import { describe, it, expect } from "vitest";
import { activeCallRoom, newRoomId } from "../callRoom";
import type { DecryptedMessage } from "../blobPayload";

const ev = (event: "started" | "ended", roomId?: string, sentAt = 1) =>
  ({ messageId: `${event}${sentAt}`, senderKeyHash: "a", sentAt, type: "call_event", event, roomId }) as DecryptedMessage;
const text = (sentAt: number) => ({ messageId: `t${sentAt}`, senderKeyHash: "a", sentAt, type: "text", body: "hi" }) as DecryptedMessage;

describe("call rooms", () => {
  it("are random and URL-safe", () => {
    const a = newRoomId();
    expect(a).toMatch(/^room-[A-Za-z0-9_-]{22}$/);
    expect(newRoomId()).not.toBe(a);
  });

  it("join the latest started call until it ends", () => {
    const r1 = newRoomId();
    const r2 = newRoomId();
    expect(activeCallRoom([])).toBeNull();
    expect(activeCallRoom([ev("started", r1, 1), text(2)])).toBe(r1);
    expect(activeCallRoom([ev("started", r1, 1), ev("ended", undefined, 2)])).toBeNull();
    expect(activeCallRoom([ev("started", r1, 1), ev("ended", undefined, 2), ev("started", r2, 3)])).toBe(r2);
    expect(activeCallRoom([ev("started", "not a room", 1)])).toBeNull();
  });
});
