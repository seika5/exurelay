import { describe, it, expect } from "vitest";
import { activeMentionQuery, encodeDraft, mentionsMe, mentionsOf, splitMentions, EVERYONE } from "../mentions";
import type { DecryptedMessage } from "../blobPayload";

const A = "a".repeat(64);
const B = "b".repeat(64);
const text = (body: string, mentions: string[], extra: Partial<DecryptedMessage> = {}) =>
  ({ messageId: "m", senderKeyHash: A, sentAt: 1, type: "text", body, mentions, ...extra }) as DecryptedMessage;

describe("mentions", () => {
  it("turns picked names into tokens, longest name first, and splits them back out", () => {
    const { body, mentions } = encodeDraft("hi @Ana B and @Ana, @everyone", [
      { label: "Ana", keyHash: A },
      { label: "Ana B", keyHash: B },
      { label: EVERYONE, keyHash: EVERYONE },
    ]);
    expect(body).toBe(`hi <@${B}> and <@${A}>, <@everyone>`);
    expect(mentions.sort()).toEqual([A, B, EVERYONE].sort());
    expect(splitMentions(body)).toEqual([{ text: "hi " }, { mention: B }, { text: " and " }, { mention: A }, { text: ", " }, { mention: EVERYONE }]);
  });

  it("only counts mentions that are both listed and in the body, never your own message", () => {
    expect(mentionsOf(text(`hey <@${B}>`, [B, A]))).toEqual([B]);
    expect(mentionsMe(text(`hey <@${B}>`, [B]), B)).toBe(true);
    expect(mentionsMe(text(`hey <@${B}>`, [B], { senderKeyHash: B }), B)).toBe(false);
    expect(mentionsMe(text("<@everyone>", [EVERYONE], { groupMemberKeyHashes: [A, B] }), B)).toBe(true);
    expect(mentionsMe(text("<@everyone>", [EVERYONE]), B)).toBe(false); // @everyone only counts in groups
  });

  it("finds the @query being typed", () => {
    expect(activeMentionQuery("hello @an", 9)).toEqual({ start: 6, query: "an" });
    expect(activeMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMentionQuery("mail@x", 6)).toBeNull();
    expect(activeMentionQuery("@ana done", 9)).toBeNull();
  });
});
