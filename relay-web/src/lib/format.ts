/**
 * Message formatting, parsed when a message is shown (the sender sends plain text): `code`, ```code blocks```,
 * **bold**, *italic* or _italic_, bare links, and mention tokens (mentions.ts). Nothing inside code is parsed.
 * Pure, so the renderer (Mentions.tsx) only maps nodes to elements and never touches HTML.
 */

import { MENTION_TOKEN } from "./mentions";

export type FmtNode =
  | { type: "text"; text: string }
  | { type: "mention"; id: string }
  | { type: "link"; href: string; text: string }
  | { type: "code"; text: string }
  | { type: "codeBlock"; text: string }
  | { type: "bold"; children: FmtNode[] }
  | { type: "italic"; children: FmtNode[] };

// Built with RegExp, since tsconfig's ES5 target rejects y and u flags in literals (every browser we run on has them).
const MENTION = new RegExp(MENTION_TOKEN, "y");
const URL_START = new RegExp("(?:https?://|www\\.)[^\\s<>\"`]+", "iy");
/** Punctuation that ends a sentence more often than a link. */
const TRAILING = /[.,!?;:'"*_~]$/;
const ALNUM = new RegExp("[\\p{L}\\p{N}]", "u");
const WORD = new RegExp("[\\p{L}\\p{N}_]", "u");
const SPACE = /\s/;

type Span = { end: number; node: FmtNode };

/**
 * Where the code is, found before anything else so emphasis can't open or close inside it. A fence takes an
 * optional language word on its first line (ignored). The newline right after a block is dropped, since the block
 * already starts and ends its own line.
 */
function codeSpans(s: string): Map<number, Span> {
  const spans = new Map<number, Span>();
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "`") {
      i++;
      continue;
    }
    let run = 1;
    while (s[i + run] === "`") run++;
    if (run >= 3) {
      const close = s.indexOf("```", i + 3);
      let text = close < 0 ? "" : s.slice(i + 3, close).replace(/^[\w+#.-]*\n/, "");
      if (text.endsWith("\n")) text = text.slice(0, -1);
      if (close < 0 || !text.trim()) {
        i += run;
        continue;
      }
      let end = close + 3;
      if (s[end] === "\n") end++;
      spans.set(i, { end, node: { type: "codeBlock", text } });
      i = end;
      continue;
    }
    // `code` or ``code with a ` in it``: closed by a run of the same length.
    const fence = "`".repeat(run);
    let close = s.indexOf(fence, i + run);
    while (close >= 0 && s[close + run] === "`") {
      let j = close;
      while (s[j] === "`") j++;
      close = s.indexOf(fence, j);
    }
    let text = close < 0 ? "" : s.slice(i + run, close);
    if (run === 2 && text.startsWith(" ") && text.endsWith(" ") && text.length > 2) text = text.slice(1, -1);
    if (close < 0 || !text.trim()) {
      i += run;
      continue;
    }
    spans.set(i, { end: close + run, node: { type: "code", text } });
    i = close + run;
  }
  return spans;
}

/** A bare link starting at `i`, minus trailing punctuation and unbalanced closing brackets. Only http(s). */
function matchUrl(s: string, i: number): { end: number; node: FmtNode } | null {
  URL_START.lastIndex = i;
  const m = URL_START.exec(s);
  if (!m) return null;
  let raw = m[0];
  for (;;) {
    if (TRAILING.test(raw)) raw = raw.slice(0, -1);
    else if (raw.endsWith(")") && count(raw, "(") < count(raw, ")")) raw = raw.slice(0, -1);
    else if (raw.endsWith("]") && count(raw, "[") < count(raw, "]")) raw = raw.slice(0, -1);
    else break;
  }
  const www = /^www\./i.test(raw);
  if (www && raw.length <= 4) return null;
  const href = www ? `https://${raw}` : raw;
  try {
    const u = new URL(href);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
  } catch {
    return null;
  }
  return { end: i + raw.length, node: { type: "link", href, text: raw } };
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** Parse a message body into formatting nodes. */
export function parseFormatting(s: string): FmtNode[] {
  const spans = codeSpans(s);
  // A closer search that failed from some position fails from any later one too, so long runs of unmatched
  // markers stay linear.
  const noClose = new Map<string, number>();

  /** The next valid closing delimiter at or after `from`, skipping code. */
  const findClose = (from: number, d: "**" | "*" | "_"): number => {
    const failed = noClose.get(d);
    if (failed !== undefined && from >= failed) return -1;
    for (let j = from; j < s.length; ) {
      const span = spans.get(j);
      if (span) {
        j = span.end;
        continue;
      }
      if (j > from && s.startsWith(d, j) && !SPACE.test(s[j - 1])) {
        const after = s[j + d.length] ?? "";
        if (d === "**" && after !== "*") return j;
        if (d === "*" && after !== "*" && s[j - 1] !== "*") return j;
        if (d === "_" && !WORD.test(after)) return j;
      }
      j++;
    }
    noClose.set(d, Math.min(from, failed ?? Infinity));
    return -1;
  };

  const out: FmtNode[] = [];
  let buf = "";
  const push = (n: FmtNode) => {
    if (buf) out.push({ type: "text", text: buf });
    buf = "";
    out.push(n);
  };

  let i = 0;
  while (i < s.length) {
    const span = spans.get(i);
    if (span) {
      push(span.node);
      i = span.end;
      continue;
    }
    const ch = s[i];
    const prev = s[i - 1] ?? "";
    if (ch === "<") {
      MENTION.lastIndex = i;
      const m = MENTION.exec(s);
      if (m) {
        push({ type: "mention", id: m[1] });
        i += m[0].length;
        continue;
      }
    }
    if ((ch === "h" || ch === "H" || ch === "w" || ch === "W") && !ALNUM.test(prev)) {
      const link = matchUrl(s, i);
      if (link) {
        push(link.node);
        i = link.end;
        continue;
      }
    }
    // Emphasis opens only right before a non-space, so "2 * 3 * 4" stays as typed; _ also not mid-word (snake_case).
    const next = s[i + 1] ?? "";
    if (ch === "*" && next === "*" && s[i + 2] && !SPACE.test(s[i + 2])) {
      const j = findClose(i + 2, "**");
      if (j >= 0) {
        push({ type: "bold", children: parseFormatting(s.slice(i + 2, j)) });
        i = j + 2;
        continue;
      }
    }
    if (ch === "*" && next && next !== "*" && !SPACE.test(next)) {
      const j = findClose(i + 1, "*");
      if (j >= 0) {
        push({ type: "italic", children: parseFormatting(s.slice(i + 1, j)) });
        i = j + 1;
        continue;
      }
    }
    if (ch === "_" && !WORD.test(prev) && next && next !== "_" && !SPACE.test(next)) {
      const j = findClose(i + 1, "_");
      if (j >= 0) {
        push({ type: "italic", children: parseFormatting(s.slice(i + 1, j)) });
        i = j + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  if (buf) out.push({ type: "text", text: buf });
  return out;
}
