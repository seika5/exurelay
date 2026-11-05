import { afterEach, describe, expect, it, vi } from "vitest";
import { checkNewServer } from "../server";

afterEach(() => vi.unstubAllGlobals());

describe("checkNewServer", () => {
  const respond = (fn: () => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(fn));

  it("is ready when the server answers without a member list", async () => {
    respond(async () => new Response(JSON.stringify({ directory: null })));
    expect(await checkNewServer("https://relay.example.com")).toBe("ready");
  });

  it("is claimed when the server already has a member list", async () => {
    respond(async () => new Response(JSON.stringify({ directory: { body: "{}", signature: "x" } })));
    expect(await checkNewServer("https://relay.example.com")).toBe("claimed");
  });

  it("is starting while the server doesn't answer, or answers with an error", async () => {
    respond(async () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await checkNewServer("https://relay.example.com")).toBe("starting");
    respond(async () => new Response("Bad Gateway", { status: 502 }));
    expect(await checkNewServer("https://relay.example.com")).toBe("starting");
  });
});
