import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Only accept requests addressed to and sent from this machine. Rejects DNS-rebinding and
 * cross-site writes; LAN access is blocked separately by binding the server to 127.0.0.1.
 */
function isLocalRequest(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    if (!LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname)) return false;
    const origin = request.headers.get("origin");
    return !origin || LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** PUT /api/identity — body = raw identity binary. Writes to public/identity/identity.bin so it persists across reloads. */
export async function PUT(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const body = await request.arrayBuffer();
    if (!body || body.byteLength === 0) {
      return NextResponse.json({ error: "Empty body" }, { status: 400 });
    }
    const dir = join(process.cwd(), "public", "identity");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "identity.bin");
    await writeFile(filePath, new Uint8Array(body));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to write identity binary:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save identity" },
      { status: 500 }
    );
  }
}
