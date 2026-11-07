/** Pure helpers for the open chat: where the "New" line goes, and in-chat search (on this device only). */

/**
 * The first message from someone else after the read mark, as an index into the chat's messages; -1 if none.
 * Matches the chat list's unread dot (useMessages' readMarks).
 */
export function firstUnreadIndex(
  messages: readonly { sentAt: number; senderKeyHash: string }[],
  readMark: number,
  myKeyHash: string
): number {
  return messages.findIndex((m) => m.sentAt > readMark && m.senderKeyHash !== myKeyHash);
}

/** The ids of the messages whose text contains the query (any case), newest first. */
export function findMatches(items: readonly { id: string; text: string }[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) if (items[i].text.toLowerCase().includes(q)) out.push(items[i].id);
  return out;
}

/** Where the query occurs in a text (any case), as [start, end) pairs. */
export function matchRanges(text: string, query: string): [number, number][] {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  // Lowercasing can change the length of a few characters (e.g. "İ"): then offsets wouldn't line up, so none.
  if (!q || t.length !== text.length) return [];
  const out: [number, number][] = [];
  for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + q.length)) out.push([i, i + q.length]);
  return out;
}
