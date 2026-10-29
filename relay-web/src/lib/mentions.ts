/**
 * @mentions (DESIGN.md §8 "Decided: @mentions"). A text message's body carries `<@keyHash>` or `<@everyone>`
 * tokens where the mentions are, and `mentions` lists them. Names are never sent: each viewer shows a mention
 * with their own name for that person.
 */

import type { DecryptedMessage } from "./blobPayload";

export const EVERYONE = "everyone";
const TOKEN = /<@([0-9a-f]{64}|everyone)>/g;

export type Segment = { text: string } | { mention: string };

/** Split a body into plain text and mention tokens, in order. */
export function splitMentions(body: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN)) {
    if (m.index! > last) out.push({ text: body.slice(last, m.index) });
    out.push({ mention: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}

/** The mentions a message really makes: listed in `mentions` and present in the body. */
export function mentionsOf(m: DecryptedMessage): string[] {
  if (m.type !== "text" || !Array.isArray(m.mentions)) return [];
  const inBody = new Set(splitMentions(m.body).flatMap((s) => ("mention" in s ? [s.mention] : [])));
  return m.mentions.filter((k) => typeof k === "string" && inBody.has(k));
}

/** Does this message mention me (by name, or @everyone in a group I'm in)? Never my own messages. */
export function mentionsMe(m: DecryptedMessage, myKeyHash: string): boolean {
  if (m.senderKeyHash === myKeyHash) return false;
  const ms = mentionsOf(m);
  return ms.includes(myKeyHash) || (ms.includes(EVERYONE) && !!m.groupMemberKeyHashes?.includes(myKeyHash));
}

/** A mention picked in the composer: shown as "@label" in the draft, sent as a token. */
export type PickedMention = { label: string; keyHash: string };

/** Turn a draft's "@label" text for each picked mention into tokens. Longest labels first, so "@Ana B" beats "@Ana". */
export function encodeDraft(text: string, picked: PickedMention[]): { body: string; mentions: string[] } {
  let body = text;
  const mentions = new Set<string>();
  for (const p of [...picked].sort((a, b) => b.label.length - a.label.length)) {
    const shown = `@${p.label}`;
    if (!body.includes(shown)) continue;
    body = body.split(shown).join(`<@${p.keyHash}>`);
    mentions.add(p.keyHash);
  }
  return { body, mentions: [...mentions] };
}

/** The "@query" being typed just before the caret, if any: "@" at the start or after a space, no space since. */
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  return /\s/.test(query) ? null : { start: at, query };
}
