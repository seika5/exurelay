/**
 * Reaction tallies: newest from each person per emoji wins, taking one back works, and only reactions from the
 * message's own conversation count.
 */
import { describe, it, expect } from "vitest";
import { tallyReactions, validEmoji } from "../reactions";
import type { DecryptedMessage } from "../blobPayload";

const ME = "me", ANA = "ana", BO = "bo";
const text = (id: string, from: string, to: string, at: number): DecryptedMessage => ({ messageId: id, type: "text", body: "hi", senderKeyHash: from, recipientKeyHash: to, sentAt: at });
const react = (id: string, from: string, to: string, target: string, emoji: string, on: boolean, at: number): DecryptedMessage => ({
  messageId: id, type: "reaction", target, emoji, on, senderKeyHash: from, recipientKeyHash: to, sentAt: at,
});

describe("reactions", () => {
  it("counts each person once per emoji, newest wins", () => {
    const all = [
      text("m1", ANA, ME, 1),
      react("r1", ANA, ME, "m1", "👍", true, 2),
      react("r2", ME, ANA, "m1", "👍", true, 3),
      react("r3", ME, ANA, "m1", "😂", true, 4),
      react("r4", ME, ANA, "m1", "😂", false, 5),
      react("r5", ANA, ME, "m1", "👍", true, 6),
    ];
    expect(tallyReactions(all, ME).get("m1")).toEqual([{ emoji: "👍", by: [ANA, ME] }]);
  });

  it("ignores reactions from another conversation and bad emoji", () => {
    const all = [
      text("m1", ANA, ME, 1),
      react("r1", BO, ME, "m1", "👍", true, 2),
      react("r2", ANA, ME, "m1", "<script>", true, 3),
      react("r3", ANA, ME, "missing", "👍", true, 4),
    ];
    expect(tallyReactions(all, ME).get("m1")).toBeUndefined();
    expect(tallyReactions(all, ME).get("missing")).toBeUndefined();
  });

  it("keeps emoji in the order they were first used", () => {
    const all = [text("m1", ME, ANA, 1), react("a", ANA, ME, "m1", "🔥", true, 2), react("b", ME, ANA, "m1", "❤️", true, 3), react("c", ME, ANA, "m1", "🔥", true, 4)];
    expect(tallyReactions(all, ME).get("m1")?.map((r) => r.emoji)).toEqual(["🔥", "❤️"]);
  });

  it("checks emoji", () => {
    expect(validEmoji("👨‍👩‍👧‍👦")).toBe(true);
    expect(validEmoji("")).toBe(false);
    expect(validEmoji("a b")).toBe(false);
  });
});
