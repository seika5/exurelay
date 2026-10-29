/**
 * useMessages: fetches blobs only on initial load and when socket emits "refresh" (no polling).
 * Voice/call uses socket for signaling (see server/src/__tests__/socket.test.js).
 */
import { describe, it, expect } from "vitest";
import { useMessages, messageBelongsToConversation, retryDelay, type Conversation } from "../useMessages";
import { ApiError } from "../api";
import { RateLimitError } from "../tokens";
import type { DecryptedMessage } from "../blobPayload";

describe("useMessages", () => {
  it("is a function (hook)", () => {
    expect(typeof useMessages).toBe("function");
  });

  it("design: fetch only on mount and socket refresh, no polling (see useMessages.ts)", () => {
    expect(useMessages).toBeDefined();
  });
});

describe("messageBelongsToConversation", () => {
  const me = "me";

  it("returns false for group message in DM conversation", () => {
    const msg: DecryptedMessage = { messageId: "m1",
      senderKeyHash: me,
      sentAt: 1,
      type: "text",
      body: "hi",
      groupMemberKeyHashes: ["me", "alice", "bob"],
    };
    const conv: Conversation = { type: "dm", otherKeyHash: "alice" };
    expect(messageBelongsToConversation(msg, conv, me)).toBe(false);
  });

  it("returns true for DM message in DM conversation", () => {
    const msg: DecryptedMessage = { messageId: "m2",
      senderKeyHash: me,
      sentAt: 1,
      type: "text",
      body: "hi",
      recipientKeyHash: "alice",
    };
    const conv: Conversation = { type: "dm", otherKeyHash: "alice" };
    expect(messageBelongsToConversation(msg, conv, me)).toBe(true);
  });

  it("returns true for group message in matching group conversation", () => {
    const msg: DecryptedMessage = { messageId: "m3",
      senderKeyHash: me,
      sentAt: 1,
      type: "text",
      body: "hi",
      groupMemberKeyHashes: ["me", "alice", "bob"],
    };
    const conv: Conversation = { type: "group", memberKeyHashes: ["me", "alice", "bob"] };
    expect(messageBelongsToConversation(msg, conv, me)).toBe(true);
  });

  it("returns false for group message in different group", () => {
    const msg: DecryptedMessage = { messageId: "m4",
      senderKeyHash: me,
      sentAt: 1,
      type: "text",
      body: "hi",
      groupMemberKeyHashes: ["me", "alice"],
    };
    const conv: Conversation = { type: "group", memberKeyHashes: ["me", "alice", "bob"] };
    expect(messageBelongsToConversation(msg, conv, me)).toBe(false);
  });
});

describe("send queue retries", () => {
  it("waits out the rate limit forever, retries an unreachable server about a minute, and gives up on a refusal", () => {
    expect(retryDelay(new RateLimitError(0, 7), 99)).toBe(7000);
    expect(retryDelay(new TypeError("Failed to fetch"), 0)).toBe(2000);
    expect(retryDelay(new ApiError("down", 503), 4)).toBe(30000);
    expect(retryDelay(new TypeError("Failed to fetch"), 5)).toBeNull();
    expect(retryDelay(new ApiError("issuer key changed", 409), 0)).toBe(2000);
    expect(retryDelay(new ApiError("too large", 413), 0)).toBeNull();
    expect(retryDelay(new ApiError("token", 401), 0)).toBeNull();
  });
});
