import { describe, it } from "node:test";
import assert from "node:assert";
import { MAX_CIPHERTEXT_LENGTH, MAX_COPIES_PER_POST, profilesTag, validateProfileCopies } from "../profiles.js";

const hex = (c) => c.repeat(64);
const session = { keyHash: hex("a"), member: hex("m") };
const devices = new Set([hex("a"), hex("b"), hex("c")]);
const isRecipient = (k) => devices.has(k);
const copy = (over = {}) => ({ recipient: hex("b"), nonce: "AAAAAAAAAAAAAAAAAAAAAA==", ciphertext: "q83vEjRWeJA=", updatedAt: 10, ...over });

describe("validateProfileCopies", () => {
  it("accepts copies to other current devices, written as the session's member and device", () => {
    const r = validateProfileCopies({ copies: [copy(), copy({ recipient: hex("c") })] }, session, isRecipient);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.rows[0], { author: hex("m"), recipient: hex("b"), sender: hex("a"), nonce: copy().nonce, ciphertext: copy().ciphertext, updatedAt: 10 });
  });

  it("refuses unknown recipients, the sending device itself, and duplicates", () => {
    assert.strictEqual(validateProfileCopies({ copies: [copy({ recipient: hex("d") })] }, session, isRecipient).ok, false);
    assert.strictEqual(validateProfileCopies({ copies: [copy({ recipient: hex("a") })] }, session, isRecipient).ok, false);
    assert.strictEqual(validateProfileCopies({ copies: [copy(), copy()] }, session, isRecipient).ok, false);
  });

  it("refuses malformed fields and oversized batches", () => {
    for (const bad of [{ nonce: "short" }, { ciphertext: "not base64!" }, { ciphertext: "A".repeat(MAX_CIPHERTEXT_LENGTH + 4) }, { updatedAt: 0 }, { updatedAt: 1.5 }, { recipient: "B".repeat(64) }]) {
      assert.strictEqual(validateProfileCopies({ copies: [copy(bad)] }, session, isRecipient).ok, false, JSON.stringify(bad).slice(0, 40));
    }
    assert.strictEqual(validateProfileCopies({ copies: [] }, session, isRecipient).ok, false);
    const many = Array.from({ length: MAX_COPIES_PER_POST + 1 }, () => copy());
    assert.strictEqual(validateProfileCopies({ copies: many }, session, isRecipient).ok, false);
  });

  it("accepts copies padded to fit a profile picture (about 21.9K base64 characters)", () => {
    assert.ok(validateProfileCopies({ copies: [copy({ ciphertext: "A".repeat(21884) })] }, session, isRecipient).ok);
  });
});

describe("profilesTag", () => {
  const row = (over = {}) => ({ author: hex("m"), sender: hex("a"), nonce: "AAAAAAAAAAAAAAAAAAAAAA==", updatedAt: 10, ...over });

  it("is the same for the same copies in any order, with BigInt or number dates", () => {
    const a = [row(), row({ author: hex("n") })];
    assert.strictEqual(profilesTag(a), profilesTag([...a].reverse()));
    assert.strictEqual(profilesTag([row()]), profilesTag([row({ updatedAt: 10n })]));
    assert.match(profilesTag([]), /^[0-9a-f]{32}$/);
  });

  it("changes when a copy is replaced, added or removed", () => {
    const base = profilesTag([row()]);
    assert.notStrictEqual(profilesTag([row({ nonce: "BBBBBBBBBBBBBBBBBBBBBB==" })]), base);
    assert.notStrictEqual(profilesTag([row({ updatedAt: 11 })]), base);
    assert.notStrictEqual(profilesTag([row(), row({ author: hex("n") })]), base);
    assert.notStrictEqual(profilesTag([]), base);
  });
});
