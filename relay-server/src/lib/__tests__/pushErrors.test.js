/**
 * Which push service errors drop a subscription. Run: node --test src/lib/__tests__/pushErrors.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { isPermanentPushError } from "../pushErrors.js";

describe("push errors", () => {
  it("drops subscriptions the push service won't ever accept", () => {
    for (const code of [400, 401, 403, 404, 410]) assert.strictEqual(isPermanentPushError(code), true, String(code));
  });
  it("keeps them through errors that may pass", () => {
    for (const code of [413, 429, 500, 502, 503, undefined]) assert.strictEqual(isPermanentPushError(code), false, String(code));
  });
});
