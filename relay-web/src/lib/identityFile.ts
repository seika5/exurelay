/**
 * Passphrase-encrypted identity file, kept in a folder the user picks (desktop Chrome/Edge; DESIGN.md §4).
 *
 * Layout (multi-byte integers big-endian):
 *   "RELAYID" (7B) | version (1B) = 1 | PBKDF2 iterations (4B) | salt (16B)            <- header
 *   keys:     iv (12B) | length (4B) | AES-256-GCM ciphertext of { server, keys }
 *   settings: iv (12B) | length (4B) | AES-256-GCM ciphertext of { myName, contactSettings }
 *
 * PBKDF2-SHA256 over the passphrase gives a secret; HKDF splits it into a keys key and a settings key. Each section
 * is authenticated together with the header (AAD), so sections can't be swapped between files or headers edited.
 * The keys section is written once, at creation. Later saves (name, nicknames, volumes) only re-encrypt the
 * settings section, so the app keeps just the settings key in memory and never needs the private keys in readable
 * form again after unlocking.
 */

import type { ContactSettings } from "./keystore";

const MAGIC = new TextEncoder().encode("RELAYID");
const VERSION = 1;
const HEADER_LEN = MAGIC.length + 1 + 4 + 16;
/** OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. Roughly half a second in a browser. */
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 10;

export type IdentityKeys = {
  server: string;
  ecdhPublic: string;
  ecdhPrivate: JsonWebKey;
  signingPublic: string;
  signingPrivate: JsonWebKey;
};
export type IdentitySettings = { myName: string; contactSettings: ContactSettings[] };

/** What an unlocked file needs to save settings again: no passphrase, no readable private keys. */
export type FileSession = { header: Uint8Array; keysSection: Uint8Array; settingsKey: CryptoKey };

export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase, or the file is damaged.");
  }
}

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = <T>(b: ArrayBuffer) => JSON.parse(new TextDecoder().decode(b)) as T;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

const aad = (header: Uint8Array, label: string) => concat(header, new TextEncoder().encode(label));

async function deriveKeys(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const secret = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, 256);
  const hkdf = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const key = (info: string) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
      hkdf,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  return { keysKey: await key("relay-identity-keys"), settingsKey: await key("relay-identity-settings") };
}

async function seal(key: CryptoKey, plaintext: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData as BufferSource }, key, plaintext as BufferSource));
  return concat(iv, u32(ct.length), ct);
}

/** Split a section at offset: returns its iv, ciphertext and where the next section starts. */
function readSection(bytes: Uint8Array, offset: number) {
  if (bytes.length < offset + 16) throw new WrongPassphraseError();
  const iv = bytes.slice(offset, offset + 12);
  const len = new DataView(bytes.buffer, bytes.byteOffset + offset + 12, 4).getUint32(0);
  const end = offset + 16 + len;
  if (bytes.length < end) throw new WrongPassphraseError();
  return { iv, ct: bytes.slice(offset + 16, end), raw: bytes.slice(offset, end), end };
}

async function open<T>(key: CryptoKey, iv: Uint8Array, ct: Uint8Array, additionalData: Uint8Array): Promise<T> {
  try {
    return dec<T>(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: additionalData as BufferSource }, key, ct as BufferSource));
  } catch {
    throw new WrongPassphraseError();
  }
}

/** A new identity file. The private keys are readable only here, while the file is being written. */
export async function createIdentityFile(
  keys: IdentityKeys,
  settings: IdentitySettings,
  passphrase: string,
  iterations = PBKDF2_ITERATIONS
): Promise<{ bytes: Uint8Array; session: FileSession }> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const header = concat(MAGIC, new Uint8Array([VERSION]), u32(iterations), salt);
  const { keysKey, settingsKey } = await deriveKeys(passphrase, salt, iterations);
  const keysSection = await seal(keysKey, enc(keys), aad(header, "keys"));
  const settingsSection = await seal(settingsKey, enc(settings), aad(header, "settings"));
  return { bytes: concat(header, keysSection, settingsSection), session: { header, keysSection, settingsKey } };
}

/** Decrypt a file with its passphrase. Throws WrongPassphraseError if it's wrong (or the file was altered). */
export async function openIdentityFile(
  bytes: Uint8Array,
  passphrase: string
): Promise<{ keys: IdentityKeys; settings: IdentitySettings; session: FileSession }> {
  if (bytes.length < HEADER_LEN || !MAGIC.every((b, i) => bytes[i] === b)) {
    throw new Error("That isn't a Relay identity file.");
  }
  if (bytes[MAGIC.length] !== VERSION) throw new Error("This identity file is from a newer version of Relay.");
  const header = bytes.slice(0, HEADER_LEN);
  const iterations = new DataView(header.buffer).getUint32(MAGIC.length + 1);
  if (iterations < 100_000 || iterations > 10_000_000) throw new Error("This identity file is damaged.");
  const salt = header.slice(MAGIC.length + 5);
  const { keysKey, settingsKey } = await deriveKeys(passphrase, salt, iterations);
  const k = readSection(bytes, HEADER_LEN);
  const s = readSection(bytes, k.end);
  const keys = await open<IdentityKeys>(keysKey, k.iv, k.ct, aad(header, "keys"));
  const settings = await open<IdentitySettings>(settingsKey, s.iv, s.ct, aad(header, "settings"));
  return { keys, settings, session: { header, keysSection: k.raw, settingsKey } };
}

/** The same file with new settings; the keys section is copied unchanged. */
export async function rewriteSettings(session: FileSession, settings: IdentitySettings): Promise<Uint8Array> {
  return concat(session.header, session.keysSection, await seal(session.settingsKey, enc(settings), aad(session.header, "settings")));
}
