import { createHash, webcrypto } from "crypto";

/**
 * Signed records travel as { body, signature }: body is the exact JSON string that was signed,
 * so verifiers never re-serialize. Signatures are ECDSA P-256 / SHA-256 in Web Crypto's raw (r||s) form;
 * public keys are raw uncompressed points, base64. Must match relay-web/src/lib/signed.ts.
 */

/** Same scheme as the client: SHA-256 hex of the base64 ECDH public key. */
export function keyHashOf(ecdhPublicKeyBase64) {
  return createHash("sha256").update(ecdhPublicKeyBase64).digest("hex");
}

export async function verifySigned(envelope, signingPublicKeyBase64) {
  if (!envelope || typeof envelope.body !== "string" || typeof envelope.signature !== "string") return false;
  try {
    const key = await webcrypto.subtle.importKey(
      "raw",
      Buffer.from(signingPublicKeyBase64, "base64"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(envelope.signature, "base64"),
      new TextEncoder().encode(envelope.body)
    );
  } catch {
    return false;
  }
}

export function parseBody(envelope) {
  try {
    return JSON.parse(envelope.body);
  } catch {
    return null;
  }
}
