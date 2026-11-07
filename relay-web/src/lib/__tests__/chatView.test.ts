import { describe, it, expect } from "vitest";
import { findMatches, firstUnreadIndex, matchRanges } from "../chatView";

const ME = "me";
const msg = (sentAt: number, senderKeyHash = "them") => ({ sentAt, senderKeyHash });

describe("firstUnreadIndex", () => {
  it("finds the first message from someone else after the mark", () => {
    const list = [msg(1), msg(2), msg(3, ME), msg(4), msg(5)];
    expect(firstUnreadIndex(list, 2, ME)).toBe(3);
    expect(firstUnreadIndex(list, 0, ME)).toBe(0);
  });

  it("skips my own messages and finds nothing when all is read", () => {
    expect(firstUnreadIndex([msg(1), msg(2, ME), msg(3, ME)], 1, ME)).toBe(-1);
    expect(firstUnreadIndex([msg(1), msg(2)], 2, ME)).toBe(-1);
    expect(firstUnreadIndex([], 0, ME)).toBe(-1);
  });
});

describe("findMatches", () => {
  const items = [
    { id: "a", text: "Hello there" },
    { id: "b", text: "nothing" },
    { id: "c", text: "say HELLO to @Ana" },
  ];

  it("matches any case, newest first", () => {
    expect(findMatches(items, "hello")).toEqual(["c", "a"]);
    expect(findMatches(items, "@ana")).toEqual(["c"]);
  });

  it("matches nothing for an empty query", () => {
    expect(findMatches(items, "  ")).toEqual([]);
    expect(findMatches(items, "zzz")).toEqual([]);
  });
});

describe("matchRanges", () => {
  it("finds every occurrence without overlaps", () => {
    expect(matchRanges("Aa aA", "a")).toEqual([[0, 1], [1, 2], [3, 4], [4, 5]]);
    expect(matchRanges("aaaa", "aa")).toEqual([[0, 2], [2, 4]]);
    expect(matchRanges("Hi Bob", "bob")).toEqual([[3, 6]]);
  });

  it("gives up when lowercasing changes the length", () => {
    expect(matchRanges("İstanbul", "stan")).toEqual([]);
  });
});
