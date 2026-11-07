/**
 * Group identity and membership (DESIGN.md §8 "Group members").
 *
 * Identity: a group made by this version has a `groupId` on every message, `g:<128-bit hex>:<creator keyHash>`, so
 * the creator can't be forged (it's part of the id everyone files messages under). A legacy group (made before
 * groupIds) is still known by its exact member set, as before. The first membership change to a legacy group gives
 * it the id `l:<its sorted member set>`: derived, not random, so two members upgrading it at once pick the same id,
 * and every device files old (no groupId) and new messages in one conversation, under the same id as before (read
 * marks, name and history stay with it).
 *
 * Membership: `group_members` messages add or remove people. Every group message carries the sender's current member
 * list in `groupMemberKeyHashes` (older versions file messages by that list, and it's who it was sent to). Each device
 * works out the members by going through the group's messages it holds in order (sentAt, then messageId):
 * - the first one sets the starting list (its `groupMemberKeyHashes`; older ones may have expired);
 * - a `group_members` message from a member applies its changes, if allowed: anyone may add people and anyone may
 *   leave, but only the creator removes others (a legacy group has no known creator, so no one can);
 * - any other message from someone who isn't a member at that point is dropped.
 * Changes apply as deltas, not as the sender's full list, so two changes at once (an add and a leave) both stick.
 */

import type { DecryptedMessage } from "./blobPayload";

export type GroupState = {
  /** The conversation id (as conversationId gives it). */
  id: string;
  /** Sent on every message to the group; undefined for a legacy group no one has changed yet. */
  groupId?: string;
  /** Who may remove others; null for a legacy group. */
  creator: string | null;
  /** Current members, in the order they joined. */
  members: string[];
};

/** A fresh id for a group I'm making. */
export function newGroupId(creator: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `g:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}:${creator}`;
}

/** The id a legacy group takes when its members first change. */
export function legacyGroupId(members: string[]): string {
  return `l:${[...members].sort().join(",")}`;
}

/** The creator named in a groupId, or null (a legacy group, or not an id we know). */
export function groupCreator(groupId: string): string | null {
  const m = /^g:[0-9a-f]{32}:(.+)$/.exec(groupId);
  return m ? m[1] : null;
}

function validGroupId(id: unknown): id is string {
  return typeof id === "string" && (/^g:[0-9a-f]{32}:./.test(id) || /^l:./.test(id));
}

/** The conversation id of a group: a legacy one (and its `l:` id) by member set, a new one by groupId. */
export function groupConversationId(g: { groupId?: string; memberKeyHashes: string[] }): string {
  if (g.groupId && validGroupId(g.groupId)) return g.groupId.startsWith("l:") ? `group:${g.groupId.slice(2)}` : `group:${g.groupId}`;
  return `group:${[...g.memberKeyHashes].sort().join(",")}`;
}

/** A group message's conversation id, or null if it isn't a group message. */
export function groupIdOfMessage(m: DecryptedMessage): string | null {
  const list = Array.isArray(m.groupMemberKeyHashes) ? m.groupMemberKeyHashes : null;
  if (validGroupId(m.groupId) && list) return groupConversationId({ groupId: m.groupId, memberKeyHashes: list });
  if (list && list.length >= 2) return groupConversationId({ memberKeyHashes: list });
  return null;
}

/** What a message adds to a group's fields: its groupId if it has one, and the member list. */
export function groupFields(g: { groupId?: string; memberKeyHashes: string[] }): { groupMemberKeyHashes: string[]; groupId?: string } {
  return g.groupId ? { groupMemberKeyHashes: g.memberKeyHashes, groupId: g.groupId } : { groupMemberKeyHashes: g.memberKeyHashes };
}

const strings = (v: unknown): string[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.every((k) => typeof k === "string" && k.length > 0) ? (v as string[]) : null;

const order = (a: DecryptedMessage, b: DecryptedMessage) => a.sentAt - b.sentAt || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);

/**
 * Every group's current state, and the group messages to drop (from non-members, or changes that weren't allowed).
 * Pass every message held, of any kind; ones outside groups are ignored.
 */
export function computeGroups(all: DecryptedMessage[]): { groups: Map<string, GroupState>; rejected: Set<string> } {
  const byConv = new Map<string, DecryptedMessage[]>();
  for (const m of all) {
    const id = groupIdOfMessage(m);
    if (!id) continue;
    const list = byConv.get(id);
    if (list) list.push(m);
    else byConv.set(id, [m]);
  }
  const groups = new Map<string, GroupState>();
  const rejected = new Set<string>();
  for (const [id, msgs] of byConv) {
    msgs.sort(order);
    const groupId = msgs.find((m) => validGroupId(m.groupId))?.groupId;
    const creator = groupId ? groupCreator(groupId) : null;
    let members: string[] | null = null;
    for (const m of msgs) {
      const declared = m.groupMemberKeyHashes ?? [];
      if (m.type === "group_members") {
        const add = strings(m.add);
        const remove = strings(m.remove);
        if (!add || !remove || add.length + remove.length === 0) {
          rejected.add(m.messageId);
          continue;
        }
        if (!members) {
          // Nothing earlier held: start from what it says the list became. Its sender was a member before it.
          if (!declared.includes(m.senderKeyHash) && !remove.includes(m.senderKeyHash)) {
            rejected.add(m.messageId);
            continue;
          }
          members = [...new Set(declared)];
          continue;
        }
        const allowed =
          members.includes(m.senderKeyHash) && remove.every((k) => k === m.senderKeyHash || (creator !== null && m.senderKeyHash === creator));
        if (!allowed) {
          rejected.add(m.messageId);
          continue;
        }
        const gone = new Set(remove);
        members = [...members, ...add.filter((k) => !members!.includes(k))].filter((k) => !gone.has(k));
        continue;
      }
      if (!members) {
        if (!declared.includes(m.senderKeyHash)) {
          rejected.add(m.messageId);
          continue;
        }
        members = [...new Set(declared)];
        continue;
      }
      if (!members.includes(m.senderKeyHash)) rejected.add(m.messageId);
    }
    if (members) groups.set(id, { id, groupId, creator, members });
  }
  return { groups, rejected };
}

/** May `me` remove `k` from this group? Yourself (leaving) always; others only if you made it. */
export function canRemove(g: Pick<GroupState, "creator" | "members">, me: string, k: string): boolean {
  if (!g.members.includes(me) || !g.members.includes(k)) return false;
  return k === me || g.creator === me;
}

/**
 * The `group_members` message for a change (without the fields sendMessage adds), and who it goes to: the old and the
 * new members alike, so someone removed learns it. A legacy group gets its `l:` id here.
 */
export function membershipChange(
  g: { groupId?: string; memberKeyHashes: string[] },
  change: { add?: string[]; remove?: string[] }
): { message: { type: "group_members"; groupId: string; add?: string[]; remove?: string[]; groupMemberKeyHashes: string[] }; recipients: string[] } {
  const groupId = g.groupId ?? legacyGroupId(g.memberKeyHashes);
  const add = (change.add ?? []).filter((k) => !g.memberKeyHashes.includes(k));
  const remove = (change.remove ?? []).filter((k) => g.memberKeyHashes.includes(k));
  const gone = new Set(remove);
  const next = [...g.memberKeyHashes, ...add].filter((k) => !gone.has(k));
  return {
    message: {
      type: "group_members",
      groupId,
      ...(add.length ? { add } : {}),
      ...(remove.length ? { remove } : {}),
      groupMemberKeyHashes: next,
    },
    recipients: [...new Set([...g.memberKeyHashes, ...add])],
  };
}
