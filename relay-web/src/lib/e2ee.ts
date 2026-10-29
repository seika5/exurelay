import { exportPublicKey, sha256Hex } from "./crypto";

/** A member's id: SHA-256 hex of their base64 raw ECDH public key. Public, not a secret. */
export async function getKeyHashFromKeyPair(pair: CryptoKeyPair): Promise<string> {
  return sha256Hex(await exportPublicKey(pair.publicKey));
}

export { exportPublicKey } from "./crypto";
