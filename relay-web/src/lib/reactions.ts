/**
 * Reactions: an emoji on a message. Each is its own small encrypted message ({ type: "reaction", target, emoji,
 * on }) sent to the conversation like any other, so the server can't tell it from a text. Every device tallies them;
 * the newest one from each person for each emoji wins (on, or taken back). Versions without reactions ignore them.
 */
import type { DecryptedMessage } from "./blobPayload";
import { messageBelongsToConversation, type Conversation } from "./useMessages";

export type Reaction = { emoji: string; by: string[] };

/** The longest emoji we take (flags and families are several code points). */
const MAX_EMOJI_LENGTH = 16;

export function validEmoji(e: unknown): e is string {
  return typeof e === "string" && e.length > 0 && e.length <= MAX_EMOJI_LENGTH && !/[\s<>]/.test(e);
}

/** The conversation a message belongs to, as seen by `me`. */
export function conversationOf(m: DecryptedMessage, me: string): Conversation | null {
  if (m.groupMemberKeyHashes) return { type: "group", memberKeyHashes: m.groupMemberKeyHashes, groupId: m.groupId };
  const other = m.senderKeyHash === me ? m.recipientKeyHash : m.senderKeyHash;
  return other ? { type: "dm", otherKeyHash: other } : null;
}

/**
 * Who reacted with what to each message, in the order each emoji was first used. A reaction counts only if it's
 * in the same conversation as its message (no reacting into a chat you aren't in).
 */
export function tallyReactions(all: DecryptedMessage[], me: string): Map<string, Reaction[]> {
  const byId = new Map(all.map((m) => [m.messageId, m]));
  const latest = new Map<string, { on: boolean; at: number; target: string; emoji: string; by: string; first: number }>();
  for (const r of [...all].sort((a, b) => a.sentAt - b.sentAt)) {
    if (r.type !== "reaction" || !validEmoji(r.emoji) || typeof r.target !== "string") continue;
    const target = byId.get(r.target);
    const conv = target && conversationOf(target, me);
    if (!conv || !messageBelongsToConversation(r, conv, me)) continue;
    const key = `${r.target}|${r.senderKeyHash}|${r.emoji}`;
    const prev = latest.get(key);
    latest.set(key, { on: r.on === true, at: r.sentAt, target: r.target, emoji: r.emoji, by: r.senderKeyHash, first: prev?.first ?? r.sentAt });
  }
  const out = new Map<string, Map<string, { by: string[]; first: number }>>();
  for (const v of latest.values()) {
    if (!v.on) continue;
    const forMsg = out.get(v.target) ?? new Map<string, { by: string[]; first: number }>();
    const e = forMsg.get(v.emoji) ?? { by: [], first: v.first };
    e.by.push(v.by);
    e.first = Math.min(e.first, v.first);
    forMsg.set(v.emoji, e);
    out.set(v.target, forMsg);
  }
  return new Map(
    [...out].map(([id, m]) => [id, [...m].sort((a, b) => a[1].first - b[1].first).map(([emoji, { by }]) => ({ emoji, by }))])
  );
}
