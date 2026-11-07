/**
 * Edits and deletes count only from the message's own sender, in its own conversation; the newest edit wins; a
 * reply's quote is shown only for a message in the same conversation.
 */
import { describe, it, expect } from "vitest";
import { draftFromBody, replyTarget, tallyActions } from "../messageActions";
import type { DecryptedMessage } from "../blobPayload";

const ME = "me", ANA = "ana", BO = "bo";
const text = (id: string, from: string, to: string, at: number, extra: Partial<DecryptedMessage> = {}): DecryptedMessage =>
  ({ messageId: id, type: "text", body: "hi", senderKeyHash: from, recipientKeyHash: to, sentAt: at, ...extra }) as DecryptedMessage;
const edit = (id: string, from: string, to: string, target: string, body: string, at: number): DecryptedMessage => ({
  messageId: id, type: "edit", target, body, senderKeyHash: from, recipientKeyHash: to, sentAt: at,
});
const del = (id: string, from: string, to: string, target: string, at: number): DecryptedMessage => ({
  messageId: id, type: "delete", target, senderKeyHash: from, recipientKeyHash: to, sentAt: at,
});

describe("message actions", () => {
  it("shows the newest edit from the sender, whatever order they arrive in", () => {
    const all = [text("m1", ME, ANA, 1), edit("e2", ME, ANA, "m1", "second", 3), edit("e1", ME, ANA, "m1", "first", 2)];
    expect(tallyActions(all, ME).edits.get("m1")).toEqual({ body: "second", mentions: undefined, at: 3 });
    // The same on the other side.
    expect(tallyActions(all, ANA).edits.get("m1")?.body).toBe("second");
  });

  it("ignores edits and deletes from anyone but the sender", () => {
    const all = [text("m1", ANA, ME, 1), edit("e1", ME, ANA, "m1", "mine now", 2), del("d1", ME, ANA, "m1", 3)];
    const { edits, deleted } = tallyActions(all, ME);
    expect(edits.size).toBe(0);
    expect(deleted.size).toBe(0);
  });

  it("ignores edits and deletes sent into another conversation", () => {
    // Ana's message to me, "edited" and "deleted" by Ana in her DM with Bo.
    const all = [text("m1", ANA, ME, 1), edit("e1", ANA, BO, "m1", "x", 2), del("d1", ANA, BO, "m1", 3)];
    const { edits, deleted } = tallyActions(all, ME);
    expect(edits.size).toBe(0);
    expect(deleted.size).toBe(0);
  });

  it("deletes for everyone, dropping any edit", () => {
    const all = [text("m1", ANA, ME, 1), edit("e1", ANA, ME, "m1", "x", 2), del("d1", ANA, ME, "m1", 3)];
    const { edits, deleted } = tallyActions(all, ME);
    expect(deleted.has("m1")).toBe(true);
    expect(edits.has("m1")).toBe(false);
  });

  it("edits text only", () => {
    const file = { messageId: "f1", type: "file", body: "AAAA", filename: "a.png", senderKeyHash: ME, recipientKeyHash: ANA, sentAt: 1 } as DecryptedMessage;
    expect(tallyActions([file, edit("e1", ME, ANA, "f1", "x", 2)], ME).edits.size).toBe(0);
  });

  it("finds a reply's message in the same conversation only", () => {
    const m1 = text("m1", ANA, ME, 1);
    const other = text("o1", BO, ME, 1);
    const reply = text("r1", ME, ANA, 2, { replyTo: "m1" });
    const across = text("r2", ME, ANA, 3, { replyTo: "o1" });
    const gone = text("r3", ME, ANA, 4, { replyTo: "nope" });
    const byId = new Map([m1, other, reply, across, gone].map((m) => [m.messageId, m]));
    expect(replyTarget(reply, byId, ME)).toBe(m1);
    expect(replyTarget(across, byId, ME)).toBeNull();
    expect(replyTarget(gone, byId, ME)).toBe("missing");
    expect(replyTarget(m1, byId, ME)).toBeNull();
  });

  it("turns mention tokens back into a draft", () => {
    const k = "a".repeat(64);
    expect(draftFromBody(`hi <@${k}> and <@everyone>`, () => "Ana")).toEqual({
      text: "hi @Ana and @everyone",
      picked: [{ label: "Ana", keyHash: k }, { label: "everyone", keyHash: "everyone" }],
    });
  });
});
