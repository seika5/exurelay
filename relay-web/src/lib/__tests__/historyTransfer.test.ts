import { describe, it, expect } from "vitest";
import { acceptHistory, planHistory } from "../historyTransfer";
import type { CachedMessage } from "../messageCache";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const text = (id: string, sentAt: number, body = "hi"): CachedMessage => ({
  message: { type: "text", messageId: id, senderKeyHash: "a".repeat(64), sentAt, body },
  expiresAt: sentAt + 3 * DAY,
});

describe("planHistory", () => {
  it("sends the newest first, drops file contents and hidden kinds, and skips expired messages", () => {
    const file: CachedMessage = {
      message: { type: "file", messageId: "f", senderKeyHash: "a".repeat(64), sentAt: NOW - 2000, body: "BASE64DATA", filename: "x.png" },
      expiresAt: NOW + DAY,
    };
    const sync: CachedMessage = {
      message: { type: "device_sync", messageId: "s", senderKeyHash: "a".repeat(64), sentAt: NOW - 500, myName: "A", contactSettings: [], settingsAt: 1 },
      expiresAt: NOW + DAY,
    };
    const old = text("old", NOW - 40 * DAY); // past 7-day retention after its expiry
    const plan = planHistory([text("1", NOW - 3000), file, sync, old, text("2", NOW - 1000)], { retentionDays: 7, now: NOW });
    expect(plan.batches.flat().map((c) => c.message.messageId)).toEqual(["2", "f", "1"]);
    const f = plan.batches.flat().find((c) => c.message.messageId === "f")!.message;
    expect(f.type === "file" && f.body === "" && f.removed).toBe(true);
    expect(plan).toMatchObject({ copied: 3, filesWithoutContent: 1, leftOut: 0 });
  });

  it("splits into batches and stops at the total, leaving the oldest out", () => {
    const many = Array.from({ length: 50 }, (_, i) => text(`m${i}`, NOW - i * 1000, "x".repeat(900)));
    const plan = planHistory(many, { batchBytes: 4000, totalBytes: 20_000, retentionDays: 7, now: NOW });
    expect(plan.batches.length).toBeGreaterThan(1);
    for (const b of plan.batches) expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThanOrEqual(4000 + 2 * b.length);
    expect(plan.copied + plan.leftOut).toBe(50);
    expect(plan.leftOut).toBeGreaterThan(0);
    expect(plan.batches[0][0].message.messageId).toBe("m0");
  });
});

describe("acceptHistory", () => {
  it("keeps well-formed, new, unexpired messages of copied kinds only", () => {
    const items = [
      text("new", NOW - 1000),
      text("have", NOW - 1000),
      text("new", NOW - 1000), // duplicate in the same batch
      text("gone", NOW - 40 * DAY),
      { message: { type: "device_sync", messageId: "s", senderKeyHash: "a", sentAt: 1 }, expiresAt: NOW },
      { message: { type: "text", messageId: 5, senderKeyHash: "a", sentAt: 1 }, expiresAt: NOW },
      null,
    ];
    const got = acceptHistory(items, (id) => id === "have", 7, NOW);
    expect(got.map((c) => c.message.messageId)).toEqual(["new"]);
    expect(acceptHistory("nope", () => false, 7, NOW)).toEqual([]);
  });
});
