/** Where the app is served from ("" at a domain's root; "/<repo>" on a GitHub Pages project site). */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/** An app-relative path ("/sw.js") under the base path. */
export const appPath = (p: string) => `${BASE_PATH}${p}`;
