/**
 * Per-recipient push limits. Run: node --test src/lib/__tests__/pushLimits.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { createPushLimiter } from "../pushLimits.js";

describe("push limits", () => {
  it("caps each recipient per kind, whoever sends, and recovers after the window", () => {
    let t = 0;
    const l = createPushLimiter({ now: () => t });
    for (let i = 0; i < 5; i++) assert.strictEqual(l.take("mention", "ana"), true);
    assert.strictEqual(l.take("mention", "ana"), false);
    assert.strictEqual(l.take("mention", "bob"), true, "another recipient has their own allowance");
    assert.strictEqual(l.take("everyone", "ana"), true);
    assert.strictEqual(l.take("everyone", "ana"), false);
    assert.strictEqual(l.take("ring", "ana"), true);
    assert.strictEqual(l.take("ring", "ana"), false);
    t = 61_000;
    l.sweep();
    assert.strictEqual(l.take("mention", "ana"), true);
    assert.strictEqual(l.take("ring", "ana"), true);
    assert.strictEqual(l.take("nonsense", "ana"), false);
    for (let i = 0; i < 6; i++) assert.strictEqual(l.take("message", "ana"), true);
    assert.strictEqual(l.take("message", "ana"), false);
    assert.strictEqual(l.take("call", "ana"), true);
    assert.strictEqual(l.take("call", "ana"), true);
    assert.strictEqual(l.take("call", "ana"), false);
  });
});
