import { describe, it, expect } from "vitest";
import { parseFormatting, type FmtNode } from "../format";

const A = "a".repeat(64);
const t = (text: string): FmtNode => ({ type: "text", text });
const b = (...children: FmtNode[]): FmtNode => ({ type: "bold", children });
const em = (...children: FmtNode[]): FmtNode => ({ type: "italic", children });
const code = (text: string): FmtNode => ({ type: "code", text });
const block = (text: string): FmtNode => ({ type: "codeBlock", text });
const link = (text: string, href = text): FmtNode => ({ type: "link", href, text });
const mention = (id: string): FmtNode => ({ type: "mention", id });
const p = parseFormatting;

describe("parseFormatting", () => {
  it("leaves plain text alone", () => {
    expect(p("")).toEqual([]);
    expect(p("hello there\nsecond line")).toEqual([t("hello there\nsecond line")]);
  });

  it("bold and italic", () => {
    expect(p("a **b** c")).toEqual([t("a "), b(t("b")), t(" c")]);
    expect(p("a *b* c")).toEqual([t("a "), em(t("b")), t(" c")]);
    expect(p("a _b_ c")).toEqual([t("a "), em(t("b")), t(" c")]);
    expect(p("**multi\nline**")).toEqual([b(t("multi\nline"))]);
  });

  it("nests", () => {
    expect(p("**bold *and italic* here**")).toEqual([b(t("bold "), em(t("and italic")), t(" here"))]);
    expect(p("*a **b** c*")).toEqual([em(t("a "), b(t("b")), t(" c"))]);
    expect(p("***both***")).toEqual([b(em(t("both")))]);
    expect(p("_a **b**_")).toEqual([em(t("a "), b(t("b")))]);
  });

  it("leaves unmatched or spaced markers as typed", () => {
    expect(p("2 * 3 * 4")).toEqual([t("2 * 3 * 4")]);
    expect(p("**not closed")).toEqual([t("**not closed")]);
    expect(p("*not closed")).toEqual([t("*not closed")]);
    expect(p("** spaced **")).toEqual([t("** spaced **")]);
    expect(p("*a *")).toEqual([t("*a *")]);
    expect(p("****")).toEqual([t("****")]);
    expect(p("**")).toEqual([t("**")]);
    expect(p("*")).toEqual([t("*")]);
    expect(p("_")).toEqual([t("_")]);
  });

  it("doesn't italicize inside words with _", () => {
    expect(p("snake_case_name")).toEqual([t("snake_case_name")]);
    expect(p("_a_b")).toEqual([t("_a_b")]);
    expect(p("__init__")).toEqual([t("__init__")]);
    expect(p("(_yes_)")).toEqual([t("("), em(t("yes")), t(")")]);
  });

  it("inline code, with nothing parsed inside", () => {
    expect(p("run `npm i` now")).toEqual([t("run "), code("npm i"), t(" now")]);
    expect(p("`**not bold** _x_ https://a.com <@everyone>`")).toEqual([code("**not bold** _x_ https://a.com <@everyone>")]);
    expect(p("``has ` tick``")).toEqual([code("has ` tick")]);
    expect(p("`` `x` ``")).toEqual([code("`x`")]);
    expect(p("`open")).toEqual([t("`open")]);
    expect(p("``")).toEqual([t("``")]);
    expect(p("` `")).toEqual([t("` `")]);
  });

  it("emphasis doesn't close inside code", () => {
    expect(p("**a `x**` b**")).toEqual([b(t("a "), code("x**"), t(" b"))]);
    expect(p("*see `a*b`*")).toEqual([em(t("see "), code("a*b"))]);
    expect(p("`a` **b**")).toEqual([code("a"), t(" "), b(t("b"))]);
  });

  it("code blocks", () => {
    expect(p("```\nline 1\n  line 2\n```")).toEqual([block("line 1\n  line 2")]);
    expect(p("```js\nconst x = 1;\n```")).toEqual([block("const x = 1;")]);
    expect(p("```one line```")).toEqual([block("one line")]);
    expect(p("look:\n```\n**x** `y` <@everyone>\n```\nafter")).toEqual([
      t("look:\n"),
      block("**x** `y` <@everyone>"),
      t("after"),
    ]);
    expect(p("```\n  keep\n\n  spaces  \n```")).toEqual([block("  keep\n\n  spaces  ")]);
  });

  it("leaves empty or unclosed fences as typed", () => {
    expect(p("``````")).toEqual([t("``````")]);
    expect(p("```\n```")).toEqual([t("```\n```")]);
    expect(p("```never closed")).toEqual([t("```never closed")]);
    expect(p("```js\nnot closed `x`")).toEqual([t("```js\nnot closed "), code("x")]);
  });

  it("mentions in plain text and inside emphasis", () => {
    expect(p(`hi <@${A}>!`)).toEqual([t("hi "), mention(A), t("!")]);
    expect(p(`**hey <@${A}>** and *<@everyone>*`)).toEqual([b(t("hey "), mention(A)), t(" and "), em(mention("everyone"))]);
    expect(p("<@nothex>")).toEqual([t("<@nothex>")]);
  });

  it("links", () => {
    expect(p("see https://example.com/a?b=1#c")).toEqual([t("see "), link("https://example.com/a?b=1#c")]);
    expect(p("http://localhost:3000/x")).toEqual([link("http://localhost:3000/x")]);
    expect(p("go to www.example.com")).toEqual([t("go to "), link("www.example.com", "https://www.example.com")]);
    expect(p("HTTPS://EXAMPLE.COM")).toEqual([link("HTTPS://EXAMPLE.COM")]);
  });

  it("drops trailing punctuation from links", () => {
    expect(p("https://a.com.")).toEqual([link("https://a.com"), t(".")]);
    expect(p("is it https://a.com/x?")).toEqual([t("is it "), link("https://a.com/x"), t("?")]);
    expect(p("https://a.com/x!,")).toEqual([link("https://a.com/x"), t("!,")]);
    expect(p('"https://a.com"')).toEqual([t('"'), link("https://a.com"), t('"')]);
  });

  it("balances parentheses", () => {
    expect(p("(see https://a.com/x)")).toEqual([t("(see "), link("https://a.com/x"), t(")")]);
    expect(p("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([link("https://en.wikipedia.org/wiki/Foo_(bar)")]);
    expect(p("(https://en.wikipedia.org/wiki/Foo_(bar)).")).toEqual([
      t("("),
      link("https://en.wikipedia.org/wiki/Foo_(bar)"),
      t(")."),
    ]);
    expect(p("[https://a.com]")).toEqual([t("["), link("https://a.com"), t("]")]);
  });

  it("keeps underscores and stars inside links", () => {
    expect(p("https://a.com/snake_case_path")).toEqual([link("https://a.com/snake_case_path")]);
    expect(p("_https://a.com/x_y_")).toEqual([em(link("https://a.com/x_y"))]);
    expect(p("**https://a.com**")).toEqual([b(link("https://a.com"))]);
  });

  it("stops links at mentions, quotes and code", () => {
    expect(p(`https://a.com<@${A}>`)).toEqual([link("https://a.com"), mention(A)]);
    expect(p("https://a.com`x`")).toEqual([link("https://a.com"), code("x")]);
  });

  it("only links http(s) and www", () => {
    expect(p("javascript:alert(1)")).toEqual([t("javascript:alert(1)")]);
    expect(p("data:text/html,<b>x</b>")).toEqual([t("data:text/html,<b>x</b>")]);
    expect(p("ftp://a.com")).toEqual([t("ftp://a.com")]);
    expect(p("http://")).toEqual([t("http://")]);
    expect(p("www.")).toEqual([t("www.")]);
    // Not mid-word.
    expect(p("xhttps://a.com")).toEqual([t("xhttps://a.com")]);
    expect(p("awww.a.com")).toEqual([t("awww.a.com")]);
  });

  it("every link it makes is http(s)", () => {
    const tricky = ["https://a.com/javascript:alert(1)", "www.javascript:alert(1)", "http://[::1]/x", "https://a.com\nhttps://b.com"];
    const links = (ns: FmtNode[]): string[] =>
      ns.flatMap((n) => (n.type === "link" ? [n.href] : "children" in n ? links(n.children) : []));
    for (const s of tricky) for (const href of links(p(s))) expect(new URL(href).protocol).toMatch(/^https?:$/);
  });

  it("stays fast on many unmatched markers", () => {
    const s = "*a _b **c ".repeat(5000);
    const start = Date.now();
    const out = p(s);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).toEqual([t(s)]);
  });
});
