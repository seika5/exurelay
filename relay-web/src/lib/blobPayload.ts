/**
 * Decrypted message format (Slack/Discord-like): sender, timestamp, optional group, type + body.
 * Sealed into blobs by sealed.ts (protocol v2); the server never sees this.
 */

export type DecryptedMessageBody =
  | { senderKeyHash: string; sentAt: number; recipientKeyHash?: string; type: "text"; body: string; groupMemberKeyHashes?: string[]; mentions?: string[] }
  | { senderKeyHash: string; sentAt: number; recipientKeyHash?: string; type: "file"; body: string; filename?: string; fileSize?: number; groupMemberKeyHashes?: string[]; removed?: boolean }
  | { senderKeyHash: string; sentAt: number; recipientKeyHash?: string; type: "contact"; keyHash: string; publicKey: string; name?: string; groupMemberKeyHashes?: string[] }
  | { senderKeyHash: string; sentAt: number; type: "call_event"; event: "started" | "ended"; recipientKeyHash?: string; groupMemberKeyHashes?: string[] }
  | { senderKeyHash: string; sentAt: number; type: "group_rename"; newName: string; groupMemberKeyHashes: string[]; recipientKeyHash?: string };

/**
 * messageId: random UUID chosen by the sender, the same for every recipient (protocol v2). Every message may also
 * carry the sender's token issuer key id, for the cross-check in tokens.ts.
 */
export type DecryptedMessage = DecryptedMessageBody & { messageId: string; issuer?: string };

export function encodeMessage(m: DecryptedMessage): string {
  return JSON.stringify(m);
}

export function decodeMessage(s: string): DecryptedMessage {
  return JSON.parse(s) as DecryptedMessage;
}
