/**
 * Unit tests for short-lived TURN credentials (coturn use-auth-secret).
 * Run: node --test src/lib/__tests__/turn.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { createHmac } from "crypto";
import { createTurnCredentials, getIceServersFromEnv } from "../turn.js";

describe("createTurnCredentials", () => {
  it("builds an expiring username and an HMAC-SHA1 credential coturn can verify", () => {
    const now = Date.UTC(2026, 0, 1);
    const { username, credential, ttlSeconds } = createTurnCredentials("s3cret", 3600, now);
    assert.strictEqual(username, `${now / 1000 + 3600}:relay`);
    assert.strictEqual(credential, createHmac("sha1", "s3cret").update(username).digest("base64"));
    assert.strictEqual(ttlSeconds, 3600);
  });
});

describe("getIceServersFromEnv", () => {
  it("returns no servers when TURN isn't configured", () => {
    assert.deepStrictEqual(getIceServersFromEnv({}).iceServers, []);
    assert.deepStrictEqual(getIceServersFromEnv({ TURN_SECRET: "x" }).iceServers, []);
  });

  it("returns STUN and TURN entries with credentials only on TURN", () => {
    const { iceServers, ttlSeconds } = getIceServersFromEnv({
      TURN_SECRET: "x",
      TURN_URLS: "turn:relay.example:3478, turns:relay.example:5349?transport=tcp",
      STUN_URLS: "stun:relay.example:3478",
      TURN_TTL_SECONDS: "600",
    });
    assert.strictEqual(ttlSeconds, 600);
    assert.deepStrictEqual(iceServers[0], { urls: ["stun:relay.example:3478"] });
    assert.deepStrictEqual(iceServers[1].urls, ["turn:relay.example:3478", "turns:relay.example:5349?transport=tcp"]);
    assert.match(iceServers[1].username, /^\d+:relay$/);
    assert.ok(iceServers[1].credential);
  });
});
