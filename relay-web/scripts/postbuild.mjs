/**
 * After `next build` (static export to out/):
 *
 * 1. Strict Content-Security-Policy. A static host can't set headers, so it goes in a <meta> tag in every page:
 *    scripts only from this origin plus the exact inline scripts Next emitted (by SHA-256), so an injected script
 *    can't run. connect-src allows any HTTPS/WSS server, because one app talks to whichever servers you join.
 * 2. build.json: the git commit and a SHA-256 over every published file, shown in Settings, so anyone can check
 *    that the app they're running is the build published for that commit (DESIGN.md §9).
 */
import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { execSync } from "child_process";

const out = new URL("../out/", import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const sha256 = (data) => createHash("sha256").update(data).digest("base64");

// plugin-host.html has its own, stricter CSP (no network, eval only there): leave it alone.
const html = files(out).filter((f) => f.endsWith(".html") && !f.endsWith("plugin-host.html"));
for (const file of html) {
  let page = readFileSync(file, "utf8");
  const hashes = new Set();
  for (const m of page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) hashes.add(`'sha256-${sha256(m[1])}'`);
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${[...hashes].join(" ")}`,
    // React sets style attributes; Tailwind is a stylesheet from this origin.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
    "worker-src 'self'",
    "manifest-src 'self'",
    // Plugins run in sandboxed iframes of public/plugin-host.html (src/lib/plugins.ts).
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  page = page.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, "");
  page = page.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
  writeFileSync(file, page);
}

let commit = process.env.GITHUB_SHA || "";
try {
  commit ||= execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
  commit = "unknown";
}
const all = files(out)
  .filter((f) => !f.endsWith("build.json"))
  .map((f) => relative(out, f))
  .sort();
const manifest = all.map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`).join("\n");
const hash = createHash("sha256").update(manifest).digest("hex");
writeFileSync(join(out, "build.json"), JSON.stringify({ commit, hash, files: all.length, builtAt: new Date().toISOString() }, null, 2));
console.log(`postbuild: CSP added to ${html.length} page(s); build ${hash.slice(0, 16)} for ${commit.slice(0, 12)}`);
