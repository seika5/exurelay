/**
 * What plugins may ask for: theme colors only, namespaced message types they registered, small data with fallback.
 */
import { describe, it, expect } from "vitest";
import { pluginName, preparePlugin, validMessageType, validSend, validTheme, MAX_PLUGIN_SOURCE } from "../plugins";

describe("plugins", () => {
  it("accept only the six theme colors, as colors", () => {
    expect(
      validTheme({
        "--accent": "#ff7a59",
        "--bg": "rgb(10, 20, 30)",
        "--text": "url(https://evil.example/x)",
        "--muted": "red; background: url(x)",
        "position": "fixed",
      })
    ).toEqual({ "--accent": "#ff7a59", "--bg": "rgb(10, 20, 30)" });
    expect(validTheme("nope")).toEqual({});
  });

  it("send only registered, namespaced types with small data and fallback text", () => {
    const registered = new Set(["x-dice/roll"]);
    expect(validMessageType("x-dice/roll")).toBe(true);
    expect(validMessageType("text")).toBe(false);
    expect(validMessageType("x-Dice/roll")).toBe(false);
    expect(validSend({ messageType: "x-dice/roll", data: { n: 4 }, fallback: "rolled 4" }, registered)).toEqual({
      messageType: "x-dice/roll",
      data: { n: 4 },
      fallback: "rolled 4",
    });
    expect(validSend({ messageType: "x-other/thing", data: 1, fallback: "x" }, registered)).toBeNull();
    expect(validSend({ messageType: "x-dice/roll", data: 1, fallback: "  " }, registered)).toBeNull();
    expect(validSend({ messageType: "x-dice/roll", data: "x".repeat(20_000), fallback: "big" }, registered)).toBeNull();
  });

  it("pin a plugin by hash and read its name", async () => {
    const src = "// @relay-plugin name: Dice\nrelay.setTheme({})";
    const p = await preparePlugin(src, "dice.js", "https://example.com/dice.js");
    expect(p.name).toBe("Dice");
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.id).toBe(p.sha256.slice(0, 16));
    expect(pluginName("relay.x()", "file.js")).toBe("file.js");
    await expect(preparePlugin("x".repeat(MAX_PLUGIN_SOURCE + 1), "big.js")).rejects.toThrow(/too big/);
  });
});

describe("plugin host page", () => {
  it("allows exactly its own inline script, eval, and no network", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const { createHash } = await import("crypto");
    const html = readFileSync(join(__dirname, "..", "..", "..", "public", "plugin-host.html"), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)![1];
    expect(csp).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/connect-src|'self'|\*/);
  });
});
