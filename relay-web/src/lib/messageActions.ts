/**
 * Replies, edits and deletes. A reply is a text or file message with `replyTo` (its target's messageId). Edits and
 * deletes are their own small encrypted messages ({ type: "edit", target, body } and { type: "delete", target }),
 * like reactions (reactions.ts): every device tallies them, and only the target's own sender counts. Versions
 * without them ignore them (an edited message shows its first text there; a deleted one stays).
 */
import type { DecryptedMessage } from "./blobPayload";
import { splitMentions, EVERYONE, type PickedMention } from "./mentions";
import { conversationOf } from "./reactions";
import { messageBelongsToConversation } from "./useMessages";

export type Edit = { body: string; mentions?: string[]; at: number };
export type MessageActions = { edits: Map<string, Edit>; deleted: Set<string> };

/** Kinds a reply can point at: the ones shown as messages (not call events or renames). */
const REPLYABLE = new Set<string>(["text", "file", "contact", "plugin"]);

/** `a` was sent by `target`'s sender, in `target`'s conversation. */
function fromTargetSender(a: DecryptedMessage, target: DecryptedMessage | undefined, me: string): boolean {
  if (!target || a.senderKeyHash !== target.senderKeyHash) return false;
  const conv = conversationOf(target, me);
  return !!conv && messageBelongsToConversation(a, conv, me);
}

/**
 * The newest edit of each text message (from its sender only) and the messages deleted for everyone (by their
 * sender only). Ties on sentAt go to the larger messageId, so every device picks the same edit.
 */
export function tallyActions(all: DecryptedMessage[], me: string): MessageActions {
  const byId = new Map(all.map((m) => [m.messageId, m]));
  const edits = new Map<string, Edit & { id: string }>();
  const deleted = new Set<string>();
  for (const a of all) {
    if ((a.type !== "edit" && a.type !== "delete") || typeof a.target !== "string") continue;
    const target = byId.get(a.target);
    if (!fromTargetSender(a, target, me)) continue;
    if (a.type === "delete") {
      deleted.add(a.target);
      continue;
    }
    if (target!.type !== "text" || typeof a.body !== "string") continue;
    const prev = edits.get(a.target);
    if (prev && (prev.at > a.sentAt || (prev.at === a.sentAt && prev.id > a.messageId))) continue;
    const mentions = Array.isArray(a.mentions) ? a.mentions.filter((k) => typeof k === "string") : undefined;
    edits.set(a.target, { body: a.body, mentions, at: a.sentAt, id: a.messageId });
  }
  for (const id of deleted) edits.delete(id);
  return { edits: new Map([...edits].map(([id, { body, mentions, at }]) => [id, { body, mentions, at }])), deleted };
}

/**
 * What a reply's quote shows: the message it answers, "missing" if that isn't on this device, or null for no quote
 * (not a reply, or one pointing into another conversation or at something that isn't a message).
 */
export function replyTarget(
  m: DecryptedMessage,
  byId: Map<string, DecryptedMessage>,
  me: string
): DecryptedMessage | "missing" | null {
  if ((m.type !== "text" && m.type !== "file") || typeof m.replyTo !== "string") return null;
  const target = byId.get(m.replyTo);
  if (!target) return "missing";
  const conv = conversationOf(target, me);
  if (!REPLYABLE.has(target.type) || !conv || !messageBelongsToConversation(m, conv, me)) return null;
  return target;
}

/** A body with mention tokens back as "@name" text, and those mentions picked, to edit it in the composer. */
export function draftFromBody(body: string, labelFor: (keyHash: string) => string): { text: string; picked: PickedMention[] } {
  const picked = new Map<string, PickedMention>();
  const text = splitMentions(body)
    .map((s) => {
      if ("text" in s) return s.text;
      const label = s.mention === EVERYONE ? EVERYONE : labelFor(s.mention);
      picked.set(s.mention, { label, keyHash: s.mention });
      return `@${label}`;
    })
    .join("");
  return { text, picked: [...picked.values()] };
}
