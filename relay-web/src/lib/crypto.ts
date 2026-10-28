/**
 * Client-side E2EE: AES-GCM via Web Crypto API.
 * Key derivation and encryption for blobs; filename/size in payload.
 */

const ALG = "AES-GCM";
const KEY_LEN = 256;
const IV_LEN = 12;
const TAG_LEN = 128;

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits", "deriveKey"]
  ) as Promise<CryptoKeyPair>;
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(raw))));
}

export async function importPublicKey(base64: string): Promise<CryptoKey> {
  const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw",
    bin,
    { name: "ECDH", namedCurve: "P-256" },
    true, // extractable: needed for getKeyHashFromKeyPair and senderPublicKey in payloads
    [] // public key: no usages; deriveKey/deriveBits apply to private key
  );
}

/** Export private key as JWK for identity file storage. */
export async function exportPrivateKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key) as Promise<JsonWebKey>;
}

/** Import private key from JWK (identity file). */
export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits", "deriveKey"]
  );
}

/** Import full keypair from identity file data. */
export async function importKeyPair(privateKeyJwk: JsonWebKey, publicKeyBase64: string): Promise<CryptoKeyPair> {
  const [privateKey, publicKey] = await Promise.all([
    importPrivateKey(privateKeyJwk),
    importPublicKey(publicKeyBase64),
  ]);
  return { privateKey, publicKey };
}

/** Derive AES key from ECDH shared secret for a recipient's public key. */
export async function deriveAesKey(
  myPrivate: CryptoKey,
  theirPublic: CryptoKey
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "ECDH",
      public: theirPublic,
    },
    myPrivate,
    { name: ALG, length: KEY_LEN },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Protocol binding for E2EE: salt for HKDF so keys are domain-separated. */
const HKDF_SALT = new TextEncoder().encode("Relay-E2EE-v1");

/**
 * Derive a per-message AES key from ECDH using HKDF (NIST/OWASP style).
 * Uses a fixed salt for protocol binding and info (e.g. messageId) for key separation.
 * Same (myPrivate, theirPublic, info) always yields the same key; different info yields different keys.
 */
export async function deriveAesKeyFromEcdhHkdf(
  myPrivate: CryptoKey,
  theirPublic: CryptoKey,
  info: Uint8Array
): Promise<CryptoKey> {
  const ecdhBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: theirPublic },
    myPrivate,
    256
  );
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    ecdhBits,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: info as BufferSource,
    },
    hkdfKey,
    { name: ALG, length: KEY_LEN },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt payload (AES-GCM). IV is prepended; optional AAD for filename/size. */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const params: AesGcmParams = {
    name: ALG,
    iv,
    tagLength: TAG_LEN,
  };
  if (aad != null && aad.byteLength > 0) {
    params.additionalData = aad as BufferSource;
  }
  const cipher = await crypto.subtle.encrypt(params, key, plaintext as BufferSource);
  const out = new Uint8Array(iv.length + cipher.byteLength);
  out.set(iv);
  out.set(new Uint8Array(cipher), iv.length);
  return out;
}

export async function decrypt(
  key: CryptoKey,
  ciphertext: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const iv = ciphertext.slice(0, IV_LEN);
  const data = ciphertext.slice(IV_LEN);
  const params: AesGcmParams = { name: ALG, iv, tagLength: TAG_LEN };
  if (aad != null && aad.byteLength > 0) {
    params.additionalData = aad as BufferSource;
  }
  return new Uint8Array(await crypto.subtle.decrypt(params, key, data as BufferSource));
}

/** Generate a random symmetric key for content (e.g. per-message). */
export async function generateSymmetricKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: ALG, length: KEY_LEN },
    true,
    ["encrypt", "decrypt"]
  );
}

/** Export/import symmetric key as base64 for storage in payload. */
export async function exportSymmetricKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(raw))));
}

export async function importSymmetricKey(base64: string): Promise<CryptoKey> {
  const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw",
    bin,
    { name: ALG, length: KEY_LEN },
    false,
    ["encrypt", "decrypt"]
  );
}
