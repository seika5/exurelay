import { mkdir, rm, writeFile } from "fs/promises";
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

/**
 * PUT /api/identity?id=<server file id> — body = raw identity binary. Writes to public/identity/<id>.bin so it
 * persists across reloads. One file per server (the id is a hash of the server URL; see identityFileId).
 */
function fileId(request: Request): string | null {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return /^[0-9a-f]{16}$/.test(id) ? id : null;
}

export async function PUT(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = fileId(request);
  if (!id) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }
  try {
    const body = await request.arrayBuffer();
    if (!body || body.byteLength === 0) {
      return NextResponse.json({ error: "Empty body" }, { status: 400 });
    }
    const dir = join(process.cwd(), "public", "identity");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${id}.bin`);
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

/** DELETE /api/identity?id=<server file id> — removes that server's identity file when the member leaves it. */
export async function DELETE(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = fileId(request);
  if (!id) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }
  try {
    await rm(join(process.cwd(), "public", "identity", `${id}.bin`), { force: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete identity binary:", err);
    return NextResponse.json({ error: "Failed to delete identity" }, { status: 500 });
  }
}
