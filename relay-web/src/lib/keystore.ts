/**
 * Where identities live, one per server (DESIGN.md §4 "Decided: where keys live").
 *
 * - Folder (desktop Chrome/Edge): a passphrase-encrypted identity file in a folder the user picks (identityFile.ts).
 *   The browser only remembers which folder (a FileSystemDirectoryHandle); it never holds the keys at rest.
 * - App storage (phones, Firefox, Safari): the identity in IndexedDB. Private keys are generated non-extractable and
 *   stored as CryptoKey objects, so the app can use them but nothing can read the key bytes out. No export, no
 *   backup: clearing site data or deleting the Home Screen icon means re-enrolling with a new key.
 */

const DB_NAME = "relay";
const DB_VERSION = 3;
const STORE = "identities";
/** Folder-mode identities: { server, dir, fileName }. */
const FOLDERS = "folders";
/** Local message cache (messageCache.ts): encrypted messages, sync state, and app-mode cache keys. */
export const CACHE_MESSAGES = "messages";
export const CACHE_META = "cacheMeta";
export const CACHE_KEYS = "cacheKeys";

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

export type StoredIdentity = {
  /** The one server this identity belongs to (normalized URL); also the record's key. */
  server: string;
  keyPair: CryptoKeyPair;
  signingKeyPair: CryptoKeyPair;
  keyHash: string;
  publicKeyBase64: string;
  signingPublicKeyBase64: string;
  myName: string;
  contactSettings: ContactSettings[];
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "server" });
        if (!req.result.objectStoreNames.contains(FOLDERS)) req.result.createObjectStore(FOLDERS, { keyPath: "server" });
        if (!req.result.objectStoreNames.contains(CACHE_MESSAGES)) {
          req.result.createObjectStore(CACHE_MESSAGES, { keyPath: "id" }).createIndex("owner", "owner");
        }
        if (!req.result.objectStoreNames.contains(CACHE_META)) req.result.createObjectStore(CACHE_META, { keyPath: "owner" });
        if (!req.result.objectStoreNames.contains(CACHE_KEYS)) req.result.createObjectStore(CACHE_KEYS, { keyPath: "owner" });
      };
      req.onsuccess = () => {
        // Another tab upgrading the database: let go so it isn't blocked; the next call reopens.
        req.result.onversionchange = () => {
          req.result.close();
          dbPromise = null;
        };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("Close Relay in your other tabs, then reload."));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

export function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest, storeName = STORE): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () => reject(tx.error ?? new Error("Storage transaction aborted"));
      })
  );
}

/** This server's identity on this device, or null if there's none. */
export async function loadIdentity(server: string): Promise<StoredIdentity | null> {
  return (await run<StoredIdentity | undefined>("readonly", (s) => s.get(server))) ?? null;
}

/** Save (or replace) an identity. The CryptoKeys are stored as they are, still non-extractable. */
export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  const record: StoredIdentity = {
    server: identity.server,
    keyPair: identity.keyPair,
    signingKeyPair: identity.signingKeyPair,
    keyHash: identity.keyHash,
    publicKeyBase64: identity.publicKeyBase64,
    signingPublicKeyBase64: identity.signingPublicKeyBase64,
    myName: identity.myName,
    contactSettings: identity.contactSettings,
  };
  await run("readwrite", (s) => s.put(record));
}

export async function deleteIdentity(server: string): Promise<void> {
  await run("readwrite", (s) => s.delete(server));
}

/** Ask the browser not to evict our storage under pressure. Best effort; with no backups this is all we can do. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Folder mode (File System Access API: desktop Chrome/Edge only)
// ---------------------------------------------------------------------------

type PermissionMode = { mode: "read" | "readwrite" };
type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: PermissionMode) => Promise<PermissionState>;
  requestPermission?: (d: PermissionMode) => Promise<PermissionState>;
};
type PickerWindow = Window & {
  showDirectoryPicker?: (o?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
};

export type FolderRef = { server: string; dir: FileSystemDirectoryHandle; fileName: string };

/** This browser can keep reading and writing a folder the user picked. */
export function folderStorageSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";
}

/** Ask the user for a folder. Must run from a click. Throws AbortError if they cancel. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("This browser can't save to a folder.");
  return picker({ id: "relay-identity", mode: "readwrite", startIn: "documents" });
}

/** Readable file name for a server's identity, e.g. relay-chat.example.com.relayid. */
export function identityFileName(server: string): string {
  return `relay-${new URL(server).host.replace(/[^A-Za-z0-9.-]/g, "-")}.relayid`;
}

/** Read/write access to the folder. The browser may ask the user, so call this first thing in a click handler. */
export async function ensureFolderAccess(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const d = dir as DirHandle;
  if (!d.queryPermission || !d.requestPermission) return true;
  if ((await d.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return (await d.requestPermission({ mode: "readwrite" })) === "granted";
}

export async function writeFolderFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  await w.write(bytes as BufferSource);
  await w.close();
}

/** The file's bytes, or null if it isn't in the folder. */
export async function readFolderFile(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    if (e instanceof DOMException && (e.name === "NotFoundError" || e.name === "TypeMismatchError")) return null;
    throw e;
  }
}

export async function removeFolderFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
  }
}

export async function loadFolderRef(server: string): Promise<FolderRef | null> {
  return (await run<FolderRef | undefined>("readonly", (s) => s.get(server), FOLDERS)) ?? null;
}

export async function saveFolderRef(ref: FolderRef): Promise<void> {
  await run("readwrite", (s) => s.put(ref), FOLDERS);
}

export async function deleteFolderRef(server: string): Promise<void> {
  await run("readwrite", (s) => s.delete(server), FOLDERS);
}
