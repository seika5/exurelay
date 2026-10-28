/**
 * Binary identity format v5 (identity.bin). Versions 1–4 (host-generated, fixed 20 accounts) are not readable:
 * the move to self-generated keys is a hard cutover.
 *
 * - version (1B) = 5
 * - ECDH public key: len (2B) + raw bytes; ECDH private key: JWK len (4B) + utf8
 * - ECDSA signing public key: len (2B) + raw bytes; ECDSA private key: JWK len (4B) + utf8
 * - my display name: len (2B) + utf8
 * - contact settings count (2B); per contact: keyHash len (2B) + utf8, nickname len (2B) + utf8 (0 = none), volume (2B, 0-100)
 * All multi-byte lengths big-endian. Contacts themselves come from the signed member directory; the file only
 * keeps this device's local settings for them.
 */

/** A member as the UI sees it: directory keys + resolved name + local settings. */
export type Contact = {
  keyHash: string;
  publicKey: string;
  displayName: string;
  /** 0-100, default 100. */
  volume?: number;
};

/** Per-contact settings stored locally. nickname overrides the member's own display name on this device. */
export type ContactSettings = {
  keyHash: string;
  nickname?: string;
  volume: number;
};

export type IdentityData = {
  publicKeyBase64: string;
  privateKeyJwk: JsonWebKey;
  signingPublicKeyBase64: string;
  signingPrivateKeyJwk: JsonWebKey;
  myName: string;
  contactSettings: ContactSettings[];
};

const VERSION = 5;

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...Array.from(bytes)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function parseIdentityBinary(buf: ArrayBuffer): IdentityData {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  const need = (n: number) => {
    if (o + n > bytes.length) throw new Error("Identity file is truncated");
  };
  const u16 = () => {
    need(2);
    const v = view.getUint16(o, false);
    o += 2;
    return v;
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(o, false);
    o += 4;
    return v;
  };
  const raw = (len: number) => {
    need(len);
    const v = bytes.slice(o, o + len);
    o += len;
    return v;
  };
  const str = (len: number) => new TextDecoder().decode(raw(len));

  need(1);
  const version = view.getUint8(o);
  o += 1;
  if (version !== VERSION) {
    throw new Error(
      version >= 1 && version <= 4
        ? "This is an old identity file from the fixed 20 accounts, which are no longer supported. Create a new identity."
        : "Unsupported identity file version"
    );
  }

  const publicKeyBase64 = toB64(raw(u16()));
  const privateKeyJwk = JSON.parse(str(u32())) as JsonWebKey;
  const signingPublicKeyBase64 = toB64(raw(u16()));
  const signingPrivateKeyJwk = JSON.parse(str(u32())) as JsonWebKey;
  const myName = str(u16());
  const count = u16();
  const contactSettings: ContactSettings[] = [];
  for (let i = 0; i < count; i++) {
    const keyHash = str(u16());
    const nickname = str(u16()) || undefined;
    const volume = Math.min(100, Math.max(0, u16()));
    contactSettings.push({ keyHash, nickname, volume });
  }
  return { publicKeyBase64, privateKeyJwk, signingPublicKeyBase64, signingPrivateKeyJwk, myName, contactSettings };
}

export function writeIdentityBinary(data: IdentityData): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = (s: string) => new TextEncoder().encode(s);
  const u8 = (n: number) => parts.push(new Uint8Array([n]));
  const u16 = (n: number) => {
    const a = new Uint8Array(2);
    new DataView(a.buffer).setUint16(0, n, false);
    parts.push(a);
  };
  const u32 = (n: number) => {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setUint32(0, n, false);
    parts.push(a);
  };
  const short = (b: Uint8Array) => {
    u16(b.length);
    parts.push(b);
  };
  const long = (b: Uint8Array) => {
    u32(b.length);
    parts.push(b);
  };

  u8(VERSION);
  short(fromB64(data.publicKeyBase64));
  long(enc(JSON.stringify(data.privateKeyJwk)));
  short(fromB64(data.signingPublicKeyBase64));
  long(enc(JSON.stringify(data.signingPrivateKeyJwk)));
  short(enc(data.myName));
  u16(data.contactSettings.length);
  for (const c of data.contactSettings) {
    short(enc(c.keyHash));
    short(enc(c.nickname ?? ""));
    u16(Math.min(100, Math.max(0, Math.round(c.volume))));
  }

  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
