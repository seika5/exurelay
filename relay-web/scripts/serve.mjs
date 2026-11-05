/**
 * Serve the static build (out/) on 127.0.0.1, with no dependencies: `npm start` after `npm run build`.
 * Only for running your own copy locally; the official build is served by a static host (GitHub Pages).
 */
import { createServer } from "http";
import { existsSync, readFileSync, statSync } from "fs";
import { extname, join, normalize } from "path";

const root = new URL("../out/", import.meta.url).pathname;
const port = Number(process.env.PORT || process.argv[2] || 3000);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".woff2": "font/woff2",
};

createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url || "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
  if (!file.startsWith(root) || !existsSync(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": types[extname(file)] || "application/octet-stream",
    // The service worker must always be checked for updates.
    "Cache-Control": file.endsWith("sw.js") || file.endsWith(".html") ? "no-cache" : "public, max-age=3600",
  });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => console.log(`Exurelay: http://127.0.0.1:${port}`));
