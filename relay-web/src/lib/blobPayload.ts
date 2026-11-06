/**
 * Decrypted message format (Slack/Discord-like): sender, timestamp, optional group, type + body.
 * Sealed into blobs by sealed.ts (protocol v2); the server never sees this.
 */

import type { ContactSettings } from "./keystore";

export type DecryptedMessageBody =
  | { senderKeyHash: string; sentAt: number; recipientKeyHash?: string; type: "text"; body: string; groupMemberKeyHashes?: string[]; mentions?: string[] }
  | { senderKeyHash: string; sentAt: number; recipientKeyHash?: string; type: "file"; body: string; filename?: string; fileSize?: number; groupMemberKeyHashes?: string[]; removed?: boolean }
  | { senderKeyHash: string; sentAt: number; recipientKeyHash?: string; type: "contact"; keyHash: string; publicKey: string; name?: string; groupMemberKeyHashes?: string[] }
  | { senderKeyHash: string; sentAt: number; type: "call_event"; event: "started" | "ended"; recipientKeyHash?: string; groupMemberKeyHashes?: string[]; roomId?: string }
  | { senderKeyHash: string; sentAt: number; type: "group_rename"; newName: string; groupMemberKeyHashes: string[]; recipientKeyHash?: string }
  /** A plugin's message type (`x-<name>/<type>`, plugins.ts); everyone without that plugin sees the fallback. */
  | { senderKeyHash: string; sentAt: number; type: "plugin"; pluginType: string; data: unknown; fallback: string; recipientKeyHash?: string; groupMemberKeyHashes?: string[] }
  /** An emoji on a message (`target` is its messageId), or taken back (`on: false`). Tallied, never shown (reactions.ts). */
  | { senderKeyHash: string; sentAt: number; type: "reaction"; target: string; emoji: string; on: boolean; recipientKeyHash?: string; groupMemberKeyHashes?: string[] }
  /** To my own other devices only: my name and contact settings (linked devices, DESIGN.md §4). Never shown. */
  | { senderKeyHash: string; sentAt: number; type: "device_sync"; myName: string; contactSettings: ContactSettings[]; settingsAt: number; recipientKeyHash?: string; groupMemberKeyHashes?: undefined }
  /** To my own other devices only: messages saved on the sending device, each with its blob's expiry. Never shown. */
  | { senderKeyHash: string; sentAt: number; type: "history"; items: { message: DecryptedMessage; expiresAt: number }[]; recipientKeyHash?: string; groupMemberKeyHashes?: undefined };

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
