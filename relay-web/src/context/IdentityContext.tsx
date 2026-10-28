"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory as FsDirectory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import {
  importKeyPair,
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  generateSigningKeyPair,
  importSigningKeyPair,
} from "@/lib/crypto";
import { getKeyHashFromKeyPair } from "@/lib/e2ee";
import { getDirectory, publishDirectory, publishProfile } from "@/lib/api";
import {
  parseIdentityBinary,
  writeIdentityBinary,
  type Contact,
  type ContactSettings,
} from "@/lib/identityBinary";
import {
  builtInAdminKeys,
  createEnrollmentCode as buildEnrollmentCode,
  MAX_NAME_LENGTH,
  signRecord,
  verifyDirectory,
  verifyProfiles,
  type Directory,
  type DirectoryMember,
  type Profile,
} from "@/lib/signed";

const IS_NATIVE = Capacitor.isNativePlatform();

/** Path for identity file in the app Documents directory (native only). */
const NATIVE_IDENTITY_FILE = "identity.bin";
/** Path for identity served statically (web only). */
const WEB_IDENTITY_PATH = "/identity/identity.bin";
/** Web API route for auto-save (web only, localhost-gated). */
const IDENTITY_API_PATH = "/api/identity";
/** Newest directory version this device has accepted (rollback protection). */
const DIRECTORY_VERSION_KEY = "relay.directoryVersion";
const DIRECTORY_POLL_MS = 60_000;

type IdentityState = {
  keyPair: CryptoKeyPair;
  signingKeyPair: CryptoKeyPair;
  keyHash: string;
  publicKeyBase64: string;
  signingPublicKeyBase64: string;
  myName: string;
  contactSettings: ContactSettings[];
  /** Active directory members other than me, with resolved names. Derived from the verified directory. */
  contacts: Contact[];
};

type IdentityContextValue = {
  identity: IdentityState | null;
  /** True until the initial identity load has completed. */
  loading: boolean;
  /** No identity on this device yet: show the create-identity screen. */
  needsSetup: boolean;
  error: string | null;
  dismissError: () => void;
  createIdentity: (name: string) => Promise<void>;
  loadIdentityFromBytes: (buffer: ArrayBuffer) => Promise<void>;
  /** Verified member directory, or null before the first admin publishes one. */
  directory: Directory | null;
  directoryLoaded: boolean;
  directoryError: string | null;
  refreshDirectory: () => Promise<void>;
  /** I'm an active member of the verified directory. */
  enrolled: boolean;
  /** My signing key is one of the admin keys built into this app. */
  isAdmin: boolean;
  /** Admin only: sign and publish the next directory version. */
  publishSignedDirectory: (next: Directory) => Promise<void>;
  getMember: (keyHash: string) => DirectoryMember | undefined;
  isRemoved: (keyHash: string) => boolean;
  /** For others: a local nickname. For me: my display name, signed and published to the directory. */
  setDisplayName: (keyHash: string, displayName: string) => Promise<void>;
  getDisplayName: (keyHash: string) => string | undefined;
  getContactVolume: (keyHash: string) => number;
  setContactVolume: (keyHash: string, volume: number) => void;
  /** Label shown in parentheses for "Me (...)". */
  getMyDisplayName: () => string;
  /** Fresh signed enrollment code (valid 3 minutes) for the admin to paste or scan. */
  createEnrollmentCode: () => Promise<string>;
  /**
   * Web: downloads identity.bin via browser anchor.
   * Native: saves to Documents directory and opens the iOS share sheet.
   */
  saveIdentityBinary: () => Promise<void>;
  logout: () => void;
};

const IdentityContext = createContext<IdentityContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the raw identity bytes from the current in-memory state. */
async function buildIdentityBytes(identity: IdentityState): Promise<Uint8Array> {
  return writeIdentityBinary({
    publicKeyBase64: identity.publicKeyBase64,
    privateKeyJwk: await exportPrivateKey(identity.keyPair.privateKey),
    signingPublicKeyBase64: identity.signingPublicKeyBase64,
    signingPrivateKeyJwk: await exportPrivateKey(identity.signingKeyPair.privateKey),
    myName: identity.myName,
    contactSettings: identity.contactSettings,
  });
}

/**
 * Persist identity to disk. Returns false if it couldn't be saved (web app not served from localhost).
 * Native: writes to the app Documents directory via @capacitor/filesystem.
 * Web:    PUTs to /api/identity (localhost-only).
 */
async function persistIdentityBinary(identity: IdentityState): Promise<boolean> {
  const bytes = await buildIdentityBytes(identity);

  if (IS_NATIVE) {
    const base64 = btoa(String.fromCharCode(...Array.from(bytes)));
    await Filesystem.writeFile({
      path: NATIVE_IDENTITY_FILE,
      data: base64,
      directory: FsDirectory.Documents,
    });
    return true;
  }

  try {
    const res = await fetch(IDENTITY_API_PATH, {
      method: "PUT",
      body: bytes.buffer as ArrayBuffer,
      headers: { "Content-Type": "application/octet-stream" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Convert a base64 string (from Filesystem.readFile on native) to an ArrayBuffer. */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

function readMinDirectoryVersion(): number {
  try {
    return Number(localStorage.getItem(DIRECTORY_VERSION_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeMinDirectoryVersion(version: number) {
  try {
    localStorage.setItem(DIRECTORY_VERSION_KEY, String(version));
  } catch {
    // Storage unavailable: rollback protection only lasts for this session.
  }
}

// ---------------------------------------------------------------------------
// Native identity scan
// ---------------------------------------------------------------------------

/**
 * Load the identity binary from the app Documents directory.
 * Tries NATIVE_IDENTITY_FILE ("identity.bin") first; if not present, scans for
 * the first .bin file the user dragged in.
 * On success, the accepted file is saved as "identity.bin" for subsequent launches.
 */
async function loadNativeIdentity(): Promise<ArrayBuffer> {
  try {
    const result = await Filesystem.readFile({
      path: NATIVE_IDENTITY_FILE,
      directory: FsDirectory.Documents,
    });
    const buf = base64ToArrayBuffer(result.data as string);
    if (buf.byteLength > 0) return buf;
  } catch {
    // Not present yet — fall through to scan.
  }

  const dir = await Filesystem.readdir({ path: "", directory: FsDirectory.Documents });
  const binEntry = dir.files.find((f) => f.name.endsWith(".bin"));
  if (!binEntry) throw new Error("no .bin file found");

  const result = await Filesystem.readFile({
    path: binEntry.name,
    directory: FsDirectory.Documents,
  });
  const buf = base64ToArrayBuffer(result.data as string);
  if (buf.byteLength === 0) throw new Error("empty .bin file");

  await Filesystem.rename({
    from: binEntry.name,
    to: NATIVE_IDENTITY_FILE,
    directory: FsDirectory.Documents,
  });

  return buf;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type BaseIdentity = Omit<IdentityState, "contacts">;

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [base, setBase] = useState<BaseIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const profilePublishedFor = useRef<string | null>(null);

  const adminKeys = useMemo(() => builtInAdminKeys(), []);

  const adopt = useCallback(async (next: BaseIdentity, save: boolean) => {
    setBase(next);
    setNeedsSetup(false);
    if (save && !(await persistIdentityBinary(next as IdentityState))) {
      // Not on localhost: nowhere to save it automatically, so hand the file to the user.
      downloadBytes(await buildIdentityBytes(next as IdentityState), "identity.bin");
      setError(
        "Couldn't save your identity automatically, so it was downloaded instead.\n\nPut identity.bin in relay-web/public/identity/ or you'll lose this account when the page reloads."
      );
    }
  }, []);

  const loadIdentityFromBytes = useCallback(async (buffer: ArrayBuffer) => {
    setError(null);
    try {
      const data = parseIdentityBinary(buffer);
      const keyPair = await importKeyPair(data.privateKeyJwk, data.publicKeyBase64);
      const signingKeyPair = await importSigningKeyPair(data.signingPrivateKeyJwk, data.signingPublicKeyBase64);
      await adopt(
        {
          keyPair,
          signingKeyPair,
          keyHash: await getKeyHashFromKeyPair(keyPair),
          publicKeyBase64: data.publicKeyBase64,
          signingPublicKeyBase64: data.signingPublicKeyBase64,
          myName: data.myName,
          contactSettings: data.contactSettings,
        },
        IS_NATIVE
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      throw e;
    }
  }, [adopt]);

  const createIdentity = useCallback(async (name: string) => {
    setError(null);
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmed) throw new Error("Enter a name");
    const keyPair = await generateKeyPair();
    const signingKeyPair = await generateSigningKeyPair();
    await adopt(
      {
        keyPair,
        signingKeyPair,
        keyHash: await getKeyHashFromKeyPair(keyPair),
        publicKeyBase64: await exportPublicKey(keyPair.publicKey),
        signingPublicKeyBase64: await exportPublicKey(signingKeyPair.publicKey),
        myName: trimmed,
        contactSettings: [],
      },
      true
    );
  }, [adopt]);

  const dismissError = useCallback(() => setError(null), []);

  // Initial identity load. A missing file means "set up a new identity", not an error.
  useEffect(() => {
    setError(null);

    if (IS_NATIVE) {
      loadNativeIdentity()
        .then(
          (buf) => loadIdentityFromBytes(buf).catch(() => {}),
          () => setNeedsSetup(true)
        )
        .finally(() => setLoading(false));
      return;
    }

    fetch(WEB_IDENTITY_PATH)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then(async (buf) => {
        if (buf && buf.byteLength > 0) await loadIdentityFromBytes(buf).catch(() => {});
        else setNeedsSetup(true);
      })
      .catch(() => setNeedsSetup(true))
      .finally(() => setLoading(false));
  }, [loadIdentityFromBytes]);

  // ---------------------------------------------------------------------------
  // Directory
  // ---------------------------------------------------------------------------

  const refreshDirectory = useCallback(async () => {
    try {
      const res = await getDirectory();
      if (!res.directory) {
        setDirectory(null);
        setProfiles(new Map());
        setDirectoryError(null);
        return;
      }
      if (adminKeys.length === 0) {
        setDirectoryError("This build has no admin keys (NEXT_PUBLIC_ADMIN_SIGNING_KEYS), so it can't verify the member list.");
        return;
      }
      const result = await verifyDirectory(res.directory, adminKeys, readMinDirectoryVersion());
      if (!result.ok) {
        // Keep the last good directory; never fall back to an unverified or older one.
        setDirectoryError(result.error);
        return;
      }
      writeMinDirectoryVersion(result.directory.version);
      setDirectory(result.directory);
      setProfiles(await verifyProfiles(res.profiles ?? [], result.directory.members));
      setDirectoryError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      const serverUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
      setDirectoryError(
        ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."].includes(message)
          ? `Cannot reach the server (${serverUrl}).`
          : message || "Couldn't load the member list."
      );
    } finally {
      setDirectoryLoaded(true);
    }
  }, [adminKeys]);

  useEffect(() => {
    if (!base) return;
    refreshDirectory();
    const timer = setInterval(refreshDirectory, DIRECTORY_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshDirectory();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [base, refreshDirectory]);

  const enrolled = !!base && !!directory?.members.some((m) => m.keyHash === base.keyHash);
  const isAdmin = !!base && adminKeys.includes(base.signingPublicKeyBase64);

  const signAndPublishProfile = useCallback(async (identity: BaseIdentity, name: string) => {
    const env = await signRecord(identity.signingKeyPair.privateKey, {
      type: "relay-profile",
      keyHash: identity.keyHash,
      name,
      updatedAt: Date.now(),
    });
    await publishProfile(env);
  }, []);

  // Once enrolled, publish my display name if the directory doesn't have it yet.
  useEffect(() => {
    if (!base || !enrolled || !directoryLoaded) return;
    if (profiles.get(base.keyHash)?.name === base.myName) return;
    if (profilePublishedFor.current === base.myName) return;
    profilePublishedFor.current = base.myName;
    signAndPublishProfile(base, base.myName)
      .then(refreshDirectory)
      .catch(() => {
        profilePublishedFor.current = null;
      });
  }, [base, enrolled, directoryLoaded, profiles, signAndPublishProfile, refreshDirectory]);

  const publishSignedDirectory = useCallback(async (next: Directory) => {
    if (!base || !isAdmin) throw new Error("Only an admin can change the member list");
    if (next.signer !== base.signingPublicKeyBase64) throw new Error("Directory signer must be this admin");
    await publishDirectory(await signRecord(base.signingKeyPair.privateKey, next));
    await refreshDirectory();
  }, [base, isAdmin, refreshDirectory]);

  const getMember = useCallback(
    (keyHash: string) => directory?.members.find((m) => m.keyHash === keyHash),
    [directory]
  );
  const isRemoved = useCallback(
    (keyHash: string) => !!directory?.removed.some((r) => r.keyHash === keyHash),
    [directory]
  );

  // ---------------------------------------------------------------------------
  // Names and local settings
  // ---------------------------------------------------------------------------

  const resolveName = useCallback(
    (keyHash: string, settings: ContactSettings[]): string | undefined =>
      settings.find((c) => c.keyHash === keyHash)?.nickname || profiles.get(keyHash)?.name,
    [profiles]
  );

  const identity = useMemo<IdentityState | null>(() => {
    if (!base) return null;
    const contacts: Contact[] = (directory?.members ?? [])
      .filter((m) => m.keyHash !== base.keyHash)
      .map((m) => ({
        keyHash: m.keyHash,
        publicKey: m.ecdh,
        displayName: resolveName(m.keyHash, base.contactSettings) ?? m.keyHash.slice(0, 8),
        volume: base.contactSettings.find((c) => c.keyHash === m.keyHash)?.volume ?? 100,
      }));
    return { ...base, contacts };
  }, [base, directory, resolveName]);

  const updateSettings = useCallback((keyHash: string, change: Partial<ContactSettings>): BaseIdentity | null => {
    if (!base) return null;
    const existing = base.contactSettings.find((c) => c.keyHash === keyHash) ?? { keyHash, volume: 100 };
    const next = {
      ...base,
      contactSettings: [...base.contactSettings.filter((c) => c.keyHash !== keyHash), { ...existing, ...change }],
    };
    setBase(next);
    return next;
  }, [base]);

  const setDisplayName = useCallback(async (keyHash: string, displayName: string): Promise<void> => {
    if (!base) throw new Error("No identity");
    const trimmed = displayName.trim().slice(0, MAX_NAME_LENGTH);
    if (keyHash === base.keyHash) {
      if (!trimmed) throw new Error("Enter a name");
      const next = { ...base, myName: trimmed };
      setBase(next);
      profilePublishedFor.current = trimmed;
      await persistIdentityBinary(next as IdentityState);
      if (enrolled) {
        await signAndPublishProfile(next, trimmed);
        await refreshDirectory();
      }
      return;
    }
    const next = updateSettings(keyHash, { nickname: trimmed || undefined });
    if (next) await persistIdentityBinary(next as IdentityState);
  }, [base, enrolled, signAndPublishProfile, refreshDirectory, updateSettings]);

  const getDisplayName = useCallback(
    (keyHash: string): string | undefined =>
      base && keyHash === base.keyHash ? base.myName : resolveName(keyHash, base?.contactSettings ?? []),
    [base, resolveName]
  );

  const getContactVolume = useCallback(
    (keyHash: string): number => {
      const v = base?.contactSettings.find((c) => c.keyHash === keyHash)?.volume;
      return typeof v === "number" ? Math.min(100, Math.max(0, v)) : 100;
    },
    [base?.contactSettings]
  );

  const setContactVolume = useCallback((keyHash: string, volume: number) => {
    const next = updateSettings(keyHash, { volume: Math.min(100, Math.max(0, Math.round(volume))) });
    if (next) persistIdentityBinary(next as IdentityState).catch((e) => setError(e instanceof Error ? e.message : "Failed to save volume"));
  }, [updateSettings]);

  const getMyDisplayName = useCallback((): string => base?.myName || "Me", [base?.myName]);

  const createEnrollmentCode = useCallback(async () => {
    if (!base) throw new Error("No identity");
    return buildEnrollmentCode(base.keyPair.publicKey, base.signingKeyPair, base.myName);
  }, [base]);

  const saveIdentityBinary = useCallback(async (): Promise<void> => {
    if (!identity) throw new Error("No identity loaded");
    const bytes = await buildIdentityBytes(identity);

    if (IS_NATIVE) {
      const base64 = btoa(String.fromCharCode(...Array.from(bytes)));
      const writeResult = await Filesystem.writeFile({
        path: NATIVE_IDENTITY_FILE,
        data: base64,
        directory: FsDirectory.Documents,
      });
      await Share.share({
        title: "identity.bin",
        text: "Relay identity file",
        url: writeResult.uri,
      });
      return;
    }

    downloadBytes(bytes, "identity.bin");
  }, [identity]);

  const logout = useCallback(() => setBase(null), []);

  return (
    <IdentityContext.Provider
      value={{
        identity,
        loading,
        needsSetup,
        error,
        dismissError,
        createIdentity,
        loadIdentityFromBytes,
        directory,
        directoryLoaded,
        directoryError,
        refreshDirectory,
        enrolled,
        isAdmin,
        publishSignedDirectory,
        getMember,
        isRemoved,
        setDisplayName,
        getDisplayName,
        getContactVolume,
        setContactVolume,
        getMyDisplayName,
        createEnrollmentCode,
        saveIdentityBinary,
        logout,
      }}
    >
      {children}
    </IdentityContext.Provider>
  );
}

export function useIdentity() {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error("useIdentity must be used within IdentityProvider");
  return ctx;
}
