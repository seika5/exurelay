/**
 * Call rooms: random ids, and joining the room named by the conversation's latest "started" event.
 */
import { describe, it, expect } from "vitest";
import { activeCall, newRoomId } from "../callRoom";
import { newRoomKey } from "../callIntro";
import type { DecryptedMessage } from "../blobPayload";

const ev = (event: "started" | "ended", roomId?: string, sentAt = 1, roomKey?: string) =>
  ({ messageId: `${event}${sentAt}`, senderKeyHash: "a", sentAt, type: "call_event", event, roomId, roomKey }) as DecryptedMessage;
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
    const k2 = newRoomKey();
    expect(activeCall([])).toBeNull();
    expect(activeCall([ev("started", r1, 1), text(2)])).toEqual({ roomId: r1 });
    expect(activeCall([ev("started", r1, 1), ev("ended", undefined, 2)])).toBeNull();
    expect(activeCall([ev("started", r1, 1), ev("ended", undefined, 2), ev("started", r2, 3, k2)])).toEqual({ roomId: r2, roomKey: k2 });
    expect(activeCall([ev("started", "not a room", 1)])).toBeNull();
  });

  it("treat a call without a valid secret as one an older app started", () => {
    const r = newRoomId();
    expect(activeCall([ev("started", r, 1, "not a key")])).toEqual({ roomId: r });
  });
});
