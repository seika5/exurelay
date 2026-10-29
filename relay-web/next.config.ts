import type { NextConfig } from "next";

// A static export (out/): the official build and forks are plain files on any HTTPS host (DESIGN.md §9).
// scripts/postbuild.mjs then adds the strict CSP and build.json. BASE_PATH is for hosts that serve the app under a
// path, like a GitHub Pages project site (/<repo>); the deploy workflow sets it.
const basePath = process.env.BASE_PATH || "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "export",
  images: { unoptimized: true },
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
