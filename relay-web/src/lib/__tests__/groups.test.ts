import { describe, it, expect } from "vitest";
import {
  canRemove,
  computeGroups,
  groupConversationId,
  groupCreator,
  groupFields,
  groupIdOfMessage,
  legacyGroupId,
  membershipChange,
  newGroupId,
} from "../groups";
import { conversationId, conversationIdOf, messageBelongsToConversation, type Conversation } from "../useMessages";
import { conversationOf, tallyReactions } from "../reactions";
import type { DecryptedMessage } from "../blobPayload";

const A = "aaaa";
const B = "bbbb";
const C = "cccc";
const D = "dddd";

let seq = 0;
function text(from: string, at: number, members: string[], groupId?: string): DecryptedMessage {
  return { messageId: `t${++seq}`, senderKeyHash: from, sentAt: at, type: "text", body: "hi", groupMemberKeyHashes: members, ...(groupId ? { groupId } : {}) };
}
function change(from: string, at: number, groupId: string, members: string[], c: { add?: string[]; remove?: string[] }): DecryptedMessage {
  return { messageId: `c${++seq}`, senderKeyHash: from, sentAt: at, type: "group_members", groupId, groupMemberKeyHashes: members, ...c };
}

describe("group ids", () => {
  it("names the creator in a new id, and legacy ids have none", () => {
    const id = newGroupId(A);
    expect(id).toMatch(/^g:[0-9a-f]{32}:aaaa$/);
    expect(newGroupId(A)).not.toBe(id);
    expect(groupCreator(id)).toBe(A);
    expect(groupCreator(legacyGroupId([B, A]))).toBeNull();
    expect(groupCreator("g:short:aaaa")).toBeNull();
  });

  it("files a legacy group's upgraded id under its old member-set id", () => {
    const legacy = conversationId({ type: "group", memberKeyHashes: [C, A, B] }, A);
    expect(legacy).toBe(`group:${A},${B},${C}`);
    expect(groupConversationId({ groupId: legacyGroupId([B, C, A]), memberKeyHashes: [A, B, C, D] })).toBe(legacy);
  });

  it("files a new group by its id, whatever the member list says", () => {
    const g = newGroupId(A);
    const m1 = text(A, 1, [A, B], g);
    const m2 = text(B, 2, [A, B, C], g);
    expect(groupIdOfMessage(m1)).toBe(`group:${g}`);
    expect(groupIdOfMessage(m2)).toBe(`group:${g}`);
    expect(conversationIdOf(m2, A)).toBe(`group:${g}`);
    const conv: Conversation = { type: "group", memberKeyHashes: [A, B, C], groupId: g };
    expect(messageBelongsToConversation(m1, conv, A)).toBe(true);
    // Not the legacy group with the same members.
    expect(messageBelongsToConversation(text(A, 3, [A, B, C]), conv, A)).toBe(false);
    expect(messageBelongsToConversation(m1, { type: "dm", otherKeyHash: B }, A)).toBe(false);
  });

  it("keeps legacy messages filed as before", () => {
    expect(groupIdOfMessage(text(A, 1, [B, A]))).toBe(`group:${A},${B}`);
    // Fewer than two members and no id: not a group message.
    expect(groupIdOfMessage(text(A, 1, [A]))).toBeNull();
    // An id we don't know is ignored (filed by member set).
    expect(groupIdOfMessage(text(A, 1, [A, B], "x:nope"))).toBe(`group:${A},${B}`);
  });

  it("groupFields leaves out the id of a legacy group", () => {
    expect(groupFields({ memberKeyHashes: [A, B] })).toEqual({ groupMemberKeyHashes: [A, B] });
    expect(groupFields({ memberKeyHashes: [A, B], groupId: "g:x" })).toEqual({ groupMemberKeyHashes: [A, B], groupId: "g:x" });
  });
});

describe("computeGroups: new groups", () => {
  const g = newGroupId(A);
  const id = `group:${g}`;

  it("starts from the first message's list", () => {
    const { groups, rejected } = computeGroups([text(A, 1, [A, B], g), text(B, 2, [A, B], g)]);
    expect(groups.get(id)).toEqual({ id, groupId: g, creator: A, members: [A, B] });
    expect(rejected.size).toBe(0);
  });

  it("lets any member add people, and the added one then speaks", () => {
    const add = change(B, 2, g, [A, B, C], { add: [C] });
    const fromC = text(C, 3, [A, B, C], g);
    const { groups, rejected } = computeGroups([text(A, 1, [A, B], g), add, fromC]);
    expect(groups.get(id)!.members).toEqual([A, B, C]);
    expect(rejected.size).toBe(0);
  });

  it("drops messages from someone not yet (or no longer) a member", () => {
    const early = text(C, 1.5, [A, B, C], g);
    const add = change(A, 2, g, [A, B, C], { add: [C] });
    const remove = change(A, 3, g, [A, B], { remove: [C] });
    const late = text(C, 4, [A, B, C], g);
    const { groups, rejected } = computeGroups([text(A, 1, [A, B], g), early, add, remove, late]);
    expect(groups.get(id)!.members).toEqual([A, B]);
    expect([...rejected].sort()).toEqual([early.messageId, late.messageId].sort());
  });

  it("only the creator removes others", () => {
    const byB = change(B, 2, g, [A, B], { remove: [C] });
    const { groups, rejected } = computeGroups([text(A, 1, [A, B, C], g), byB]);
    expect(groups.get(id)!.members).toEqual([A, B, C]);
    expect(rejected.has(byB.messageId)).toBe(true);
    const byA = change(A, 2, g, [A, B], { remove: [C] });
    expect(computeGroups([text(A, 1, [A, B, C], g), byA]).groups.get(id)!.members).toEqual([A, B]);
  });

  it("anyone can leave, the creator too, and then can't do anything", () => {
    const leave = change(A, 2, g, [B, C], { remove: [A] });
    const after = change(A, 3, g, [B, C, D], { add: [D] });
    const { groups, rejected } = computeGroups([text(A, 1, [A, B, C], g), leave, after]);
    expect(groups.get(id)!.members).toEqual([B, C]);
    expect(rejected.has(leave.messageId)).toBe(false);
    expect(rejected.has(after.messageId)).toBe(true);
  });

  it("applies changes as deltas, so two at once both stick", () => {
    // C leaves while B, not having seen that, adds D (B's list still has C).
    const leave = change(C, 2, g, [A, B], { remove: [C] });
    const add = change(B, 3, g, [A, B, C, D], { add: [D] });
    expect(computeGroups([text(A, 1, [A, B, C], g), add, leave]).groups.get(id)!.members).toEqual([A, B, D]);
  });

  it("re-adds someone who left", () => {
    const msgs = [text(A, 1, [A, B, C], g), change(C, 2, g, [A, B], { remove: [C] }), change(B, 3, g, [A, B, C], { add: [C] })];
    expect(computeGroups(msgs).groups.get(id)!.members).toEqual([A, B, C]);
  });

  it("ignores empty or malformed changes", () => {
    const empty = change(A, 2, g, [A, B], {});
    const bad = { ...change(A, 3, g, [A, B], {}), add: [5] } as unknown as DecryptedMessage;
    const { groups, rejected } = computeGroups([text(A, 1, [A, B], g), empty, bad]);
    expect(groups.get(id)!.members).toEqual([A, B]);
    expect(rejected.has(empty.messageId) && rejected.has(bad.messageId)).toBe(true);
  });

  it("a joiner who holds only the add starts from it", () => {
    const add = change(B, 5, g, [A, B, C], { add: [C] });
    const { groups } = computeGroups([add, text(A, 6, [A, B, C], g)]);
    expect(groups.get(id)).toEqual({ id, groupId: g, creator: A, members: [A, B, C] });
  });

  it("a first message whose sender isn't on its own list is dropped", () => {
    const stray = text(D, 1, [A, B], g);
    const { groups, rejected } = computeGroups([stray, text(A, 2, [A, B], g)]);
    expect(rejected.has(stray.messageId)).toBe(true);
    expect(groups.get(id)!.members).toEqual([A, B]);
  });

  it("orders by sentAt, then messageId, whatever order they arrive in", () => {
    const msgs = [text(A, 1, [A, B], g), change(B, 2, g, [A, B, C], { add: [C] }), change(C, 3, g, [A, B], { remove: [C] })];
    const a = computeGroups(msgs).groups.get(id);
    const b = computeGroups([...msgs].reverse()).groups.get(id);
    expect(a).toEqual(b);
    expect(a!.members).toEqual([A, B]);
  });
});

describe("computeGroups: legacy groups", () => {
  const legacy = `group:${A},${B},${C}`;

  it("works as before until someone changes the members", () => {
    const { groups, rejected } = computeGroups([text(A, 1, [A, B, C]), text(C, 2, [C, B, A])]);
    expect(groups.get(legacy)).toEqual({ id: legacy, groupId: undefined, creator: null, members: [A, B, C] });
    expect(rejected.size).toBe(0);
  });

  it("upgrades on the first change, keeping the old messages in one chat", () => {
    const conv = { memberKeyHashes: [A, B, C] };
    const { message } = membershipChange(conv, { add: [D] });
    const up = { ...message, messageId: "up", senderKeyHash: B, sentAt: 2 } as DecryptedMessage;
    const fromD = text(D, 3, [A, B, C, D], message.groupId);
    const { groups, rejected } = computeGroups([text(A, 1, [A, B, C]), up, fromD]);
    expect(groups.size).toBe(1);
    expect(groups.get(legacy)).toEqual({ id: legacy, groupId: legacyGroupId([A, B, C]), creator: null, members: [A, B, C, D] });
    expect(rejected.size).toBe(0);
    expect(conversationIdOf(fromD, A)).toBe(legacy);
  });

  it("two members upgrading at once pick the same id", () => {
    const one = membershipChange({ memberKeyHashes: [A, B, C] }, { add: [D] }).message;
    const two = membershipChange({ memberKeyHashes: [C, B, A] }, { remove: [B] }).message;
    expect(one.groupId).toBe(two.groupId);
  });

  it("no one can remove others (no known creator), but anyone can leave", () => {
    const g = legacyGroupId([A, B, C]);
    const kick = change(A, 2, g, [A, B], { remove: [C] });
    const leave = change(B, 3, g, [A, C], { remove: [B] });
    const { groups, rejected } = computeGroups([text(A, 1, [A, B, C]), kick, leave]);
    expect(rejected.has(kick.messageId)).toBe(true);
    expect(groups.get(legacy)!.members).toEqual([A, C]);
  });

  it("drops an old-version message from someone who has left", () => {
    const g = legacyGroupId([A, B, C]);
    const late = text(B, 3, [A, B, C]);
    const { rejected } = computeGroups([text(A, 1, [A, B, C]), change(B, 2, g, [A, C], { remove: [B] }), late]);
    expect(rejected.has(late.messageId)).toBe(true);
  });
});

describe("canRemove and membershipChange", () => {
  it("allows leaving, and removing others only for the creator", () => {
    const g = { creator: A, members: [A, B, C] };
    expect(canRemove(g, A, B)).toBe(true);
    expect(canRemove(g, B, C)).toBe(false);
    expect(canRemove(g, B, B)).toBe(true);
    expect(canRemove(g, A, D)).toBe(false);
    expect(canRemove({ creator: null, members: [A, B] }, A, B)).toBe(false);
    expect(canRemove(g, D, D)).toBe(false);
  });

  it("sends the new list to old and new members, and skips no-ops", () => {
    const g = newGroupId(A);
    const r = membershipChange({ memberKeyHashes: [A, B, C], groupId: g }, { add: [D, B], remove: [C, D] });
    expect(r.message).toEqual({ type: "group_members", groupId: g, add: [D], remove: [C], groupMemberKeyHashes: [A, B, D] });
    expect(r.recipients.sort()).toEqual([A, B, C, D]);
  });

  it("round-trips through computeGroups", () => {
    const g = newGroupId(A);
    const start = text(A, 1, [A, B], g);
    const { message } = membershipChange({ memberKeyHashes: [A, B], groupId: g }, { add: [C] });
    const sent = { ...message, messageId: "x", senderKeyHash: A, sentAt: 2 } as DecryptedMessage;
    expect(computeGroups([start, sent]).groups.get(`group:${g}`)!.members).toEqual(message.groupMemberKeyHashes);
  });
});

describe("reactions in groups with ids", () => {
  it("count a member's reaction to a message whose list was different", () => {
    const g = newGroupId(A);
    const target = text(A, 1, [A, B], g);
    const r: DecryptedMessage = { messageId: "r1", senderKeyHash: C, sentAt: 3, type: "reaction", target: target.messageId, emoji: "👍", on: true, groupMemberKeyHashes: [A, B, C], groupId: g };
    expect(conversationOf(target, A)).toEqual({ type: "group", memberKeyHashes: [A, B], groupId: g });
    expect(tallyReactions([target, r], A).get(target.messageId)).toEqual([{ emoji: "👍", by: [C] }]);
  });
});
